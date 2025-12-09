// server.js
// Tavari Voice Agent - Telnyx + OpenAI Realtime

import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

if (!OPENAI_API_KEY || !TELNYX_API_KEY) {
  console.error('❌ Missing required environment variables');
  console.error('Required: OPENAI_API_KEY, TELNYX_API_KEY');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Create WebSocket server for media streaming
const wss = new WebSocketServer({ 
  server,
  path: '/media-stream-ws'
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check (required for Railway)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'tavari-voice-agent'
  });
});

// Store active sessions: callId -> { openaiClient, callControlId, ... }
const sessions = new Map();

/**
 * Handle Telnyx webhook events
 */
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body.data;
    const eventType = event.event_type;
    const callId = event.payload?.call_control_id || event.payload?.call_session_id;
    
    console.log(`📞 Telnyx event: ${eventType} for call ${callId}`);

    // Always respond 200 to Telnyx
    res.status(200).send('OK');

    switch (eventType) {
      case 'call.initiated':
        await handleCallInitiated(event.payload, callId);
        break;
      
      case 'call.answered':
        await handleCallAnswered(event.payload, callId);
        break;
      
      case 'call.hangup':
      case 'call.bridged':
        await handleCallHangup(callId);
        break;
      
      case 'media.stream.started':
        console.log(`🎵 Media stream started for ${callId}`);
        break;
      
      case 'media.stream.ended':
        console.log(`🎵 Media stream ended for ${callId}`);
        break;
      
      default:
        console.log(`ℹ️  Unhandled event type: ${eventType}`);
    }
  } catch (error) {
    console.error('❌ Error handling webhook:', error);
  }
});

/**
 * Handle call initiated - Answer call and start OpenAI Realtime
 */
async function handleCallInitiated(payload, callId) {
  try {
    const callControlId = payload.call_control_id;
    
    console.log(`📞 Call initiated: ${callControlId}`);

    // Answer the call
    await answerCall(callControlId);

    // Start OpenAI Realtime session
    await startOpenAIRealtimeSession(callId, callControlId);

  } catch (error) {
    console.error('❌ Error handling call initiated:', error);
  }
}

/**
 * Handle call answered - Start media streaming
 */
async function handleCallAnswered(payload, callId) {
  try {
    const callControlId = payload.call_control_id;
    
    console.log(`✅ Call answered: ${callControlId}`);

    // Check if OpenAI session is ready
    const session = sessions.get(callId);
    if (session && session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
      console.log(`✅ OpenAI session ready, starting media stream for ${callId}`);
      // Start media streaming to receive audio
      await startMediaStream(callControlId, callId);
    } else {
      console.log(`⚠️  OpenAI session not ready yet for ${callId}, marking for pending media start`);
      // Mark this session as needing media stream start when OpenAI is ready
      if (session) {
        session.pendingMediaStart = true;
        session.callControlId = callControlId;
      }
    }

  } catch (error) {
    console.error('❌ Error handling call answered:', error);
  }
}

/**
 * Handle call hangup - Cleanup
 */
async function handleCallHangup(callId) {
  try {
    console.log(`📴 Call hangup: ${callId}`);

    const session = sessions.get(callId);
    if (session) {
      // Close OpenAI WebSocket
      if (session.openaiWs) {
        try {
          session.openaiWs.close();
          console.log(`🔌 Closed OpenAI WebSocket for ${callId}`);
        } catch (error) {
          console.error('Error closing OpenAI:', error);
        }
      }

      // Close Telnyx media WebSocket
      if (session.telnyxWs) {
        try {
          session.telnyxWs.close();
          console.log(`🔌 Closed Telnyx WebSocket for ${callId}`);
        } catch (error) {
          console.error('Error closing Telnyx:', error);
        }
      }

      // Remove session
      sessions.delete(callId);
      console.log(`🗑️  Removed session for ${callId}`);
    }
  } catch (error) {
    console.error('❌ Error handling hangup:', error);
  }
}

/**
 * Answer the call via Telnyx API
 */
async function answerCall(callControlId) {
  try {
    const response = await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ Call answered: ${callControlId}`);
    return response.data;
  } catch (error) {
    console.error('❌ Error answering call:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Start media streaming to receive audio via WebSocket
 */
async function startMediaStream(callControlId, callId) {
  try {
    // Fix Railway domain URL normalization
    let base = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${PORT}`;
    
    // Remove protocol if present and normalize
    base = base.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
    
    // Use WebSocket URL for media streaming
    const webhookUrl = `wss://${base}/media-stream-ws?call_id=${callId}`;

    console.log("🚀 Using media stream URL:", webhookUrl);

    const response = await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
      {
        stream_url: webhookUrl,
        stream_track: "both_tracks"
      },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        }
      }
    );

    console.log(`🎵 Media streaming started: ${callControlId}`);
    return response.data;

  } catch (error) {
    console.error("❌ Error starting media stream:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Start OpenAI Realtime session using WebSocket
 */
async function startOpenAIRealtimeSession(callId, callControlId) {
  try {
    console.log(`🤖 Starting OpenAI Realtime session for ${callId}...`);

    // Create WebSocket connection to OpenAI Realtime API
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    // Store session
    sessions.set(callId, {
      openaiWs: ws,
      callControlId: callControlId,
      startedAt: new Date()
    });

    // WebSocket event handlers
    ws.on('open', async () => {
      console.log(`✅ OpenAI Realtime WebSocket connected for ${callId}`);
      
      // Send session configuration
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful AI assistant for Tavari. Be concise and natural in conversation.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          },
          temperature: 0.8,
          max_response_output_tokens: 4096
        }
      }));

      console.log(`✅ OpenAI session configured for ${callId}`);

      // Create conversation item and request response
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Hello, thank you for calling Tavari. How can I help you today?'
          }]
        }
      }));

      console.log(`✅ Conversation item created for ${callId}`);

      // Request response with both audio and text
      ws.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio']
        }
      }));

      console.log(`🎤 Requested audio+text response for ${callId}`);

      // Check if media stream start was pending (race condition fix)
      const session = sessions.get(callId);
      if (session && session.pendingMediaStart && session.callControlId) {
        console.log(`🔄 Starting pending media stream for ${callId}`);
        try {
          await startMediaStream(session.callControlId, callId);
          session.pendingMediaStart = false;
        } catch (error) {
          console.error(`❌ Error starting pending media stream for ${callId}:`, error);
        }
      }
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'response.audio_transcript.delta':
            if (message.delta) {
              process.stdout.write(message.delta);
            }
            break;
          
          case 'response.audio_transcript.done':
            console.log(`\n🤖 AI said: ${message.transcript}`);
            break;
          
          case 'response.audio.delta':
            // Audio chunk from OpenAI
            if (message.delta) {
              const audioBuffer = Buffer.from(message.delta, 'base64');
              sendAudioToTelnyx(callId, audioBuffer);
            }
            break;
          
          case 'response.audio.done':
            console.log(`🎵 Audio response complete for ${callId}`);
            break;

          case 'response.done':
            console.log(`✅ Response complete for ${callId}`);
            break;
          
          case 'conversation.item.input_audio_transcription.completed':
            console.log(`👤 User said: "${message.transcript}"`);
            break;
          
          case 'conversation.item.input_audio_transcription.failed':
            console.log(`❌ Transcription failed for ${callId}`);
            break;
          
          case 'input_audio_buffer.speech_started':
            console.log(`👤 User started speaking for ${callId}`);
            break;
          
          case 'input_audio_buffer.speech_stopped':
            console.log(`👤 User stopped speaking for ${callId}`);
            break;
          
          case 'error':
            console.error(`❌ OpenAI error for ${callId}:`, message);
            break;
          
          default:
            // Unhandled event types - log for debugging
            if (message.type && !message.type.startsWith('session.')) {
              // console.log(`ℹ️  Unhandled OpenAI event: ${message.type}`);
            }
        }
      } catch (error) {
        console.error(`❌ Error parsing OpenAI message for ${callId}:`, error);
      }
    });

    ws.on('error', (error) => {
      console.error(`❌ OpenAI WebSocket error for ${callId}:`, error);
    });

    ws.on('close', () => {
      console.log(`🔌 OpenAI WebSocket closed for ${callId}`);
      const session = sessions.get(callId);
      if (session && session.openaiWs === ws) {
        sessions.delete(callId);
      }
    });

  } catch (error) {
    console.error(`❌ Error starting OpenAI session for ${callId}:`, error);
    sessions.delete(callId);
  }
}

/**
 * Send audio to Telnyx call using streaming
 */
async function sendAudioToTelnyx(callId, audioBuffer) {
  try {
    const session = sessions.get(callId);
    if (!session || !session.telnyxWs) {
      console.warn(`⚠️  No Telnyx WebSocket session found for ${callId}`);
      return;
    }

    // Send raw binary PCM audio to Telnyx (NOT JSON)
    if (session.telnyxWs.readyState === WebSocket.OPEN) {
      session.telnyxWs.send(audioBuffer);
    }

  } catch (error) {
    console.error(`❌ Error sending audio to Telnyx for ${callId}:`, error.response?.data || error.message);
  }
}

// WebSocket server for media streaming from Telnyx
wss.on('connection', (ws, req) => {
  console.log('🔌 Telnyx WebSocket connection established');
  console.log('🔍 WebSocket URL:', req.url);
  console.log('🔍 WebSocket headers:', req.headers);
  
  // Extract call_id from URL parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callId = url.searchParams.get('call_id');
  
  console.log('🔍 Extracted call_id from URL:', callId);

  if (!callId) {
    console.error('❌ No call_id in WebSocket connection');
    ws.close();
    return;
  }

  // Store the Telnyx WebSocket in the session
  const session = sessions.get(callId);
  if (session) {
    session.telnyxWs = ws;
    console.log(`🎵 Telnyx media stream WebSocket connected (call: ${callId})`);
  } else {
    console.warn(`⚠️  No session found for call_id: ${callId}`);
  }

  ws.on('message', (data) => {
    console.log(`📥 Received ${data.length} bytes from Telnyx WebSocket`);
    
    try {
      const event = JSON.parse(data.toString());
      
      if (event.event === 'media' && event.media && event.media.payload) {
        // Get the session and forward audio to OpenAI
        const session = sessions.get(callId);
        if (session && session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
          session.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: event.media.payload
          }));
        }
      }
    } catch (error) {
      // Handle binary audio data
      if (data.length > 0) {
        const session = sessions.get(callId);
        if (session && session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
          const audioBase64 = data.toString('base64');
          session.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: audioBase64
          }));
        }
      }
    }
  });

  ws.on('close', () => {
    console.log(`🔌 Telnyx WebSocket closed for ${callId}`);
    const session = sessions.get(callId);
    if (session) {
      session.telnyxWs = null;
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ Telnyx WebSocket error for ${callId}:`, error);
  });

  console.log('✅ WebSocket ready to receive audio from Telnyx');
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tavari Voice Agent server running on port ${PORT}`);
  const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`;

  console.log(`📞 Webhook: POST ${PUBLIC_URL}/webhook`);
  console.log(`🎵 Media stream WebSocket: wss://${PUBLIC_URL}/media-stream-ws`);
  console.log(`❤️  Health check: GET ${PUBLIC_URL}/health`);
  console.log(`\n✅ Ready to receive calls!`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  // Close all OpenAI sessions
  sessions.forEach((session, callId) => {
    if (session.openaiWs) {
      session.openaiWs.close();
    }
    if (session.telnyxWs) {
      session.telnyxWs.close();
    }
  });
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  sessions.forEach((session, callId) => {
    if (session.openaiWs) {
      session.openaiWs.close();
    }
    if (session.telnyxWs) {
      session.telnyxWs.close();
    }
  });
  process.exit(0);
});
