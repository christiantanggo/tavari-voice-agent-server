// server.js
// Tavari Voice Agent - Telnyx + OpenAI Realtime

import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import dotenv from 'dotenv';

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
 * Handle call answered - Start media streaming (wait for OpenAI session to be ready)
 */
async function handleCallAnswered(payload, callId) {
  try {
    const callControlId = payload.call_control_id;
    
    console.log(`✅ Call answered: ${callControlId}`);

    // Wait for OpenAI session to be ready before starting media stream
    const maxWait = 10000; // 10 seconds max wait
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      const session = sessions.get(callId);
      if (session && session.sessionReady) {
        console.log(`✅ OpenAI session ready, starting media stream for ${callId}`);
        await startMediaStream(callControlId);
        return;
      }
      // Wait 100ms before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // If session not ready after max wait, start stream anyway
    console.log(`⚠️  OpenAI session not ready after ${maxWait}ms, starting media stream anyway`);
    await startMediaStream(callControlId);

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
 * Start media streaming to receive audio
 */
async function startMediaStream(callControlId) {
  try {
    // Get Railway public domain (Railway sets this automatically)
    let baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
    
    // Ensure URL has https:// protocol (required by Telnyx)
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      baseUrl = `https://${baseUrl}`;
    }
    
    // Telnyx requires WebSocket URL (wss://) for media streaming
    const wsUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    // Include call_id in query string to help identify the connection
    const webhookUrl = `${wsUrl}/media-stream-ws?call_id=${callControlId}`;
    console.log(`🎵 Starting media stream with WebSocket URL: ${webhookUrl}`);
    
    const response = await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
      {
        stream_url: webhookUrl,
        stream_track: 'inbound_track' // Receive inbound audio (caller's voice)
      },
      {
        headers: {
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🎵 Media streaming started: ${callControlId}`);
    return response.data;
  } catch (error) {
    console.error('❌ Error starting media stream:', error.response?.data || error.message);
    if (error.response?.data?.errors) {
      console.error('❌ Telnyx errors:', JSON.stringify(error.response.data.errors, null, 2));
    }
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
      startedAt: new Date(),
      sessionReady: false // Track if session is configured
    });

    // WebSocket event handlers
    ws.on('open', () => {
      console.log(`✅ OpenAI Realtime WebSocket connected for ${callId}`);
      
      // Send session configuration
      // Telnyx media streaming sends PCM16 at 8kHz (based on their docs)
      // OpenAI Realtime requires PCM16 at 24kHz, so we need to configure for 24kHz
      // However, we'll try pcm16 first and see if OpenAI can handle 8kHz
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful AI assistant. Be concise and natural in conversation.',
          voice: 'alloy',
          input_audio_format: 'pcm16', // Try PCM16 - OpenAI expects 24kHz but might accept 8kHz
          input_audio_transcription: {
            model: 'whisper-1'
          },
          output_audio_format: 'pcm16', // Output PCM16
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
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'session.updated':
            // Session is now ready
            console.log(`✅ OpenAI session configured for ${callId}`);
            const session = sessions.get(callId);
            if (session) {
              session.sessionReady = true;
              
              // Send greeting now that session is ready
              const greeting = 'Hello, thank you for calling. How can I help you today?';
              ws.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text'],
                  instructions: greeting
                }
              }));
            }
            break;
          
          case 'response.audio_transcript.delta':
            if (message.delta) {
              process.stdout.write(message.delta);
            }
            break;
          
          case 'response.audio_transcript.done':
            console.log(`\n🤖 AI transcript: ${message.transcript}`);
            break;
          
          case 'response.audio.delta':
            // Audio chunk from OpenAI
            if (message.delta) {
              const audioBuffer = Buffer.from(message.delta, 'base64');
              sendAudioToTelnyx(callId, audioBuffer);
              // Log occasionally to confirm audio is being received
              if (Math.random() < 0.1) {
                console.log(`📥 Received ${audioBuffer.length} bytes audio from OpenAI (${callId})`);
              }
            }
            break;
          
          case 'response.audio.done':
            console.log(`🎵 Audio response complete for ${callId}`);
            break;
          
          case 'response.done':
            console.log(`✅ Response complete for ${callId}`);
            break;
          
          case 'conversation.item.input_audio_buffer.speech_started':
            console.log(`👤 User started speaking for ${callId}`);
            break;
          
          case 'conversation.item.input_audio_buffer.speech_stopped':
            console.log(`👤 User stopped speaking for ${callId}`);
            break;
          
          case 'conversation.item.input_audio_buffer.committed':
            console.log(`✅ Audio buffer committed for ${callId}`);
            break;
          
          case 'error':
            console.error(`❌ OpenAI error for ${callId}:`, JSON.stringify(message, null, 2));
            break;
          
          default:
            // Log unknown message types occasionally for debugging
            if (message.type && !message.type.startsWith('session.') && Math.random() < 0.01) {
              console.log(`ℹ️  OpenAI message type: ${message.type} for ${callId}`);
            }
            break;
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
 * Send audio to Telnyx call
 */
async function sendAudioToTelnyx(callId, audioBuffer) {
  try {
    const session = sessions.get(callId);
    if (!session || !session.callControlId) {
      console.warn(`⚠️  No session found for ${callId}`);
      return;
    }

    // Convert audio buffer to base64
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    // Send to Telnyx using speak action
    await axios.post(
      `https://api.telnyx.com/v2/calls/${session.callControlId}/actions/speak`,
      {
        payload: audioBase64,
        payload_type: 'base64',
        voice: 'female'
      },
      {
        headers: {
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

  } catch (error) {
    console.error(`❌ Error sending audio to Telnyx for ${callId}:`, error.response?.data || error.message);
  }
}

/**
 * WebSocket server for Telnyx media streaming
 */
const wss = new WebSocketServer({ 
  server: server,
  path: '/media-stream-ws'
});

// Map WebSocket connections to call IDs
const wsCallMap = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 Telnyx WebSocket connection established');
  console.log(`🔍 WebSocket URL: ${req.url}`);
  console.log(`🔍 WebSocket headers:`, JSON.stringify(req.headers, null, 2));
  
  // Try to extract call ID from query string
  let callId = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    callId = url.searchParams.get('call_id');
    console.log(`🔍 Extracted call_id from URL: ${callId}`);
  } catch (error) {
    console.warn('⚠️  Could not parse WebSocket URL:', error);
  }
  
  // Store WebSocket with a temporary ID if we don't have call_id yet
  const wsId = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  wsCallMap.set(ws, { callId, wsId });
  
  console.log(`🎵 Telnyx media stream WebSocket connected (call: ${callId || 'pending'})`);

  // Send initial message to Telnyx (some WebSocket protocols require this)
  // Telnyx might expect a specific format - try sending a simple acknowledgment
  try {
    // Some protocols expect binary, others JSON - try binary first (empty buffer as keepalive)
    // Actually, let's not send anything until we receive data from Telnyx
    console.log(`✅ WebSocket ready to receive audio from Telnyx`);
  } catch (error) {
    console.error('❌ Error in WebSocket connection setup:', error);
  }

  ws.on('message', (data) => {
    console.log(`📥 Received ${data.length} bytes from Telnyx WebSocket`);
    try {
      const wsInfo = wsCallMap.get(ws);
      let activeCallId = wsInfo?.callId;
      
      // If we don't have call_id yet, try to find it from active sessions
      if (!activeCallId) {
        // Telnyx might send call info in first message, or we match by timing
        // For now, try to find the most recent session without a WebSocket
        for (const [id, session] of sessions.entries()) {
          if (!session.telnyxWs) {
            activeCallId = id;
            session.telnyxWs = ws;
            wsInfo.callId = id;
            console.log(`🔗 Matched WebSocket to call: ${id}`);
            break;
          }
        }
      }
      
      if (!activeCallId) {
        console.warn(`⚠️  No call ID for WebSocket message`);
        return;
      }

      const session = sessions.get(activeCallId);
      if (!session || !session.openaiWs) {
        console.warn(`⚠️  No OpenAI session for ${activeCallId}`);
        return;
      }

      // Wait for session to be ready before sending audio
      if (!session.sessionReady) {
        // Don't log every time - too noisy
        // console.log(`⏳ Waiting for OpenAI session to be ready for ${activeCallId}...`);
        return;
      }

      // Telnyx sends audio as binary data (PCM16, 8kHz mono, 16-bit little-endian)
      // OpenAI Realtime expects PCM16 at 24kHz, but we'll try sending 8kHz and see if it works
      // If not, we'll need to resample
      const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      
      // Validate buffer is not empty
      if (audioBuffer.length === 0) {
        return;
      }
      
      // Convert to base64 for OpenAI
      const audioBase64 = audioBuffer.toString('base64');
      
      // Send to OpenAI Realtime API
      if (session.openaiWs.readyState === WebSocket.OPEN) {
        try {
          session.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: audioBase64
          }));
          // Log occasionally to confirm audio is being sent (every 50th chunk)
          if (Math.random() < 0.02) {
            console.log(`📤 Sent ${audioBuffer.length} bytes to OpenAI (${activeCallId})`);
          }
        } catch (error) {
          console.error(`❌ Error sending audio to OpenAI for ${activeCallId}:`, error.message);
        }
      } else {
        console.warn(`⚠️  OpenAI WebSocket not open for ${activeCallId} (state: ${session.openaiWs.readyState})`);
      }
    } catch (error) {
      console.error('❌ Error processing Telnyx audio:', error);
    }
  });

  ws.on('close', (code, reason) => {
    const wsInfo = wsCallMap.get(ws);
    const callId = wsInfo?.callId;
    console.log(`🔌 Telnyx WebSocket closed (call: ${callId || 'unknown'}, code: ${code}, reason: ${reason?.toString() || 'none'})`);
    
    if (callId) {
      const session = sessions.get(callId);
      if (session) {
        session.telnyxWs = null;
      }
    }
    
    wsCallMap.delete(ws);
  });

  ws.on('error', (error) => {
    const wsInfo = wsCallMap.get(ws);
    const callId = wsInfo?.callId || 'unknown';
    console.error(`❌ Telnyx WebSocket error (call: ${callId}):`, error);
  });

  ws.on('pong', () => {
    console.log(`🏓 Received pong from Telnyx WebSocket`);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tavari Voice Agent server running on port ${PORT}`);
  const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`;

  console.log(`📞 Webhook: POST ${PUBLIC_URL}/webhook`);
  console.log(`🎵 Media stream WebSocket: wss://${PUBLIC_URL.replace('http://', '').replace('https://', '')}/media-stream-ws`);
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
  });
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  sessions.forEach((session, callId) => {
    if (session.openaiWs) {
      session.openaiWs.close();
    }
  });
  process.exit(0);
});

