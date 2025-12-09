// server.js
// Tavari Voice Agent - Telnyx + OpenAI Realtime
// Updated by Claude AI

import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import dotenv from 'dotenv';

/**
 * Resample PCM16 audio from 24kHz to 8kHz using linear interpolation (for output to Telnyx)
 * @param {Buffer} inputBuffer - Input PCM16 audio buffer (24kHz, 16-bit, mono)
 * @returns {Buffer} - Resampled PCM16 audio buffer (8kHz, 16-bit, mono)
 */
function resample24kHzTo8kHz(inputBuffer) {
  // Input: 24kHz = 24000 samples/second
  // Output: 8kHz = 8000 samples/second
  // Ratio: 8/24 = 1/3x downsampling
  
  // Ensure buffer length is even (16-bit samples = 2 bytes each)
  if (inputBuffer.length < 2) {
    return Buffer.alloc(0);
  }
  
  const inputSamples = Math.floor(inputBuffer.length / 2); // 16-bit = 2 bytes per sample
  const outputSamples = Math.floor(inputSamples / 3); // 1/3x downsampling
  const outputBuffer = Buffer.allocUnsafe(outputSamples * 2); // 2 bytes per sample
  
  for (let i = 0; i < outputSamples; i++) {
    // Calculate position in input buffer (every 3rd sample)
    const inputIndex = i * 3;
    const inputSampleIndex = inputIndex * 2;
    
    // Ensure we don't go beyond buffer bounds
    if (inputSampleIndex + 1 >= inputBuffer.length) {
      // Use last sample if we're at the end
      const lastSampleIndex = Math.max(0, Math.floor((inputBuffer.length - 2) / 2) * 2);
      const lastSample = inputBuffer.readInt16LE(lastSampleIndex);
      outputBuffer.writeInt16LE(lastSample, i * 2);
      continue;
    }
    
    // Read 16-bit signed integer (little-endian) - take every 3rd sample
    const sample = inputBuffer.readInt16LE(inputSampleIndex);
    
    // Write to output buffer (little-endian)
    outputBuffer.writeInt16LE(sample, i * 2);
  }
  
  return outputBuffer;
}

/**
 * Resample PCM16 audio from 8kHz to 24kHz using linear interpolation (for input to OpenAI)
 * @param {Buffer} inputBuffer - Input PCM16 audio buffer (8kHz, 16-bit, mono)
 * @returns {Buffer} - Resampled PCM16 audio buffer (24kHz, 16-bit, mono)
 */
function resample8kHzTo24kHz(inputBuffer) {
  // Input: 8kHz = 8000 samples/second
  // Output: 24kHz = 24000 samples/second
  // Ratio: 24/8 = 3x upsampling
  
  // Ensure buffer length is even (16-bit samples = 2 bytes each)
  if (inputBuffer.length < 2) {
    return Buffer.alloc(0);
  }
  
  const inputSamples = Math.floor(inputBuffer.length / 2); // 16-bit = 2 bytes per sample
  const outputSamples = inputSamples * 3; // 3x upsampling
  const outputBuffer = Buffer.allocUnsafe(outputSamples * 2); // 2 bytes per sample
  
  for (let i = 0; i < outputSamples; i++) {
    // Calculate position in input buffer (0 to inputSamples-1)
    const inputPos = i / 3;
    const inputIndex = Math.floor(inputPos);
    const fraction = inputPos - inputIndex;
    
    // Ensure we don't go beyond buffer bounds
    if (inputIndex >= inputSamples - 1) {
      // Use last sample if we're at the end
      const lastSampleIndex = (inputSamples - 1) * 2;
      if (lastSampleIndex + 1 < inputBuffer.length) {
        const lastSample = inputBuffer.readInt16LE(lastSampleIndex);
        outputBuffer.writeInt16LE(lastSample, i * 2);
      }
      continue;
    }
    
    // Get two adjacent samples for interpolation
    const sample1Index = inputIndex * 2;
    const sample2Index = (inputIndex + 1) * 2;
    
    // Ensure indices are within bounds
    if (sample1Index + 1 >= inputBuffer.length || sample2Index + 1 >= inputBuffer.length) {
      // Fallback: use last available sample
      const lastSampleIndex = Math.max(0, Math.floor((inputBuffer.length - 2) / 2) * 2);
      const lastSample = inputBuffer.readInt16LE(lastSampleIndex);
      outputBuffer.writeInt16LE(lastSample, i * 2);
      continue;
    }
    
    // Read 16-bit signed integers (little-endian)
    const sample1 = inputBuffer.readInt16LE(sample1Index);
    const sample2 = inputBuffer.readInt16LE(sample2Index);
    
    // Linear interpolation
    const interpolated = Math.round(sample1 + (sample2 - sample1) * fraction);
    
    // Clamp to 16-bit signed range
    const clamped = Math.max(-32768, Math.min(32767, interpolated));
    
    // Write to output buffer (little-endian)
    outputBuffer.writeInt16LE(clamped, i * 2);
  }
  
  return outputBuffer;
}

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

    const session = sessions.get(callId);
    if (session && session.sessionReady) {
      // OpenAI is already ready, start media stream immediately
      console.log(`✅ OpenAI session ready, starting media stream for ${callId}`);
      await startMediaStream(callControlId);
    } else {
      // Mark that we need to start media stream when OpenAI is ready
      if (session) {
        session.pendingMediaStart = true;
        session.pendingCallControlId = callControlId;
      }
      console.log(`⏳ OpenAI session not ready yet, will start media stream when ready for ${callId}`);
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
    let base = process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`;
    
    // Ensure valid https:// URL (Telnyx REQUIRES full URL with protocol)
    if (!base.startsWith('http')) {
      base = `https://${base}`;
    }
    
    // Convert http:// to https:// for production (Railway uses HTTPS)
    if (base.startsWith('http://')) {
      base = base.replace('http://', 'https://');
    }
    
    // Telnyx requires WebSocket URL (wss://) for media streaming
    const wsUrl = base.replace('https://', 'wss://');
    // Include call_id in query string to help identify the connection
    const webhookUrl = `${wsUrl}/media-stream-ws?call_id=${callControlId}`;
    
    console.log(`🚀 Using media stream URL: ${webhookUrl}`);
    
    const response = await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
      {
        stream_url: webhookUrl,
        stream_track: 'both_tracks' // Receive both inbound and outbound audio
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
      sessionReady: false, // Track if session is configured
      telnyxWs: null, // Will be set when Telnyx WebSocket connects
      pendingMediaStart: false // Track if we need to start media stream when ready
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
              
              // Send greeting as audio message
              const greeting = 'Hello, thank you for calling. How can I help you today?';
              
              // Create conversation item with correct format (type must be 'text', not 'input_text')
              ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'text', // OpenAI requires 'text', not 'input_text'
                      text: greeting
                    }
                  ]
                }
              }));
              
              console.log(`🎤 Sent greeting for ${callId}`);
              
              // If we have a pending media stream start, do it now
              if (session.pendingMediaStart && session.pendingCallControlId) {
                console.log(`🔄 Starting pending media stream for ${callId}`);
                startMediaStream(session.pendingCallControlId).catch(error => {
                  console.error(`❌ Error starting pending media stream for ${callId}:`, error);
                });
                session.pendingMediaStart = false;
                session.pendingCallControlId = null;
              }
            }
            break;
          
          case 'conversation.item.created':
            // Conversation item was created, now request audio response
            console.log(`✅ Conversation item created for ${callId}`);
            const sessionForResponse = sessions.get(callId);
            if (sessionForResponse && sessionForResponse.openaiWs) {
              // Wait a tiny bit to ensure item is fully created
              setTimeout(() => {
                sessionForResponse.openaiWs.send(JSON.stringify({
                  type: 'response.create',
                  response: {
                    modalities: ['audio', 'text'] // Must include both audio and text
                  }
                }));
                console.log(`🎤 Requested audio+text response for ${callId}`);
              }, 100);
            }
            break;
          
          case 'response.created':
            console.log(`🎬 Response created for ${callId}`);
            break;
          
          case 'response.audio_transcript.delta':
            // Text transcript while audio is being generated
            if (message.delta) {
              process.stdout.write(message.delta);
            }
            break;
          
          case 'response.audio_transcript.done':
            console.log(`\n🤖 AI transcript: ${message.transcript}`);
            break;
          
          case 'response.audio.delta':
            // Audio chunk from OpenAI - this is what we need!
            if (message.delta) {
              try {
                const audioBuffer = Buffer.from(message.delta, 'base64');
                console.log(`📥 Received ${audioBuffer.length} bytes audio from OpenAI (${callId})`);
                
                // Resample 24kHz to 8kHz for Telnyx (sendAudioToTelnyx will handle sending)
                const resampledAudio = resample24kHzTo8kHz(audioBuffer);
                if (resampledAudio.length > 0) {
                  sendAudioToTelnyx(callId, resampledAudio);
                }
              } catch (error) {
                console.error(`❌ Error processing audio delta for ${callId}:`, error);
              }
            }
            break;
          
          case 'response.audio.done':
            console.log(`🎵 Audio response complete for ${callId}`);
            break;
          
          case 'response.done':
            console.log(`✅ Response complete for ${callId}`);
            break;
          
          case 'error':
            console.error(`❌ OpenAI error for ${callId}:`, JSON.stringify(message, null, 2));
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
            // Log ALL OpenAI messages for debugging (temporarily)
            if (message.type) {
              console.log(`ℹ️  OpenAI message: ${message.type} for ${callId}`, JSON.stringify(message).substring(0, 300));
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
 * OpenAI outputs 24kHz PCM16, Telnyx requires 8kHz PCM16
 */
async function sendAudioToTelnyx(callId, audioBuffer) {
  try {
    const session = sessions.get(callId);
    if (!session || !session.callControlId) {
      console.warn(`⚠️  No session found for ${callId}`);
      return;
    }

    // Audio is already resampled to 8kHz, send directly via WebSocket if available
    if (audioBuffer.length === 0) {
      return;
    }

    // If Telnyx WebSocket is available, send raw PCM binary
    if (session.telnyxWs && session.telnyxWs.readyState === WebSocket.OPEN) {
      session.telnyxWs.send(audioBuffer);
      console.log(`📤 Sent ${audioBuffer.length} bytes raw audio to Telnyx WebSocket (${callId})`);
      return;
    }

    // Fallback to HTTP API (base64 encoded)
    const audioBase64 = audioBuffer.toString('base64');
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
    try {
      // Telnyx sends binary PCM audio data - check if it's binary or JSON
      let audioBuffer = null;
      
      if (Buffer.isBuffer(data)) {
        // Binary PCM audio data
        audioBuffer = data;
      } else if (typeof data === 'string') {
        // Could be JSON message - try to parse
        try {
          const jsonMessage = JSON.parse(data);
          console.log(`📨 Telnyx JSON message:`, jsonMessage);
          // Handle JSON messages if needed (e.g., connection status)
          return;
        } catch (e) {
          // Not JSON, treat as binary
          audioBuffer = Buffer.from(data, 'binary');
        }
      } else {
        // Convert to buffer
        audioBuffer = Buffer.from(data);
      }
      
      if (!audioBuffer || audioBuffer.length === 0) {
        return;
      }
      
      const wsInfo = wsCallMap.get(ws);
      let activeCallId = wsInfo?.callId;
      
      // If we don't have call_id yet, try to find it from active sessions
      if (!activeCallId) {
        // Try to find the most recent session without a WebSocket
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
        // Don't log every time - too noisy
        return;
      }

      const session = sessions.get(activeCallId);
      if (!session || !session.openaiWs) {
        // Don't log every time - too noisy
        return;
      }

      // Wait for session to be ready before sending audio
      if (!session.sessionReady) {
        // Don't log every time - too noisy
        return;
      }

      // Telnyx sends audio as binary data (PCM16, 8kHz mono, 16-bit little-endian)
      // OpenAI Realtime requires PCM16 at 24kHz, so we need to resample
      // Resample from 8kHz to 24kHz
      try {
        const resampledBuffer = resample8kHzTo24kHz(audioBuffer);
        if (resampledBuffer.length === 0) {
          return;
        }
        
        // Convert to base64 for OpenAI
        const audioBase64 = resampledBuffer.toString('base64');
        
        // Send to OpenAI Realtime API
        if (session.openaiWs.readyState === WebSocket.OPEN) {
          session.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: audioBase64
          }));
          // Log occasionally to confirm audio is being sent
          if (Math.random() < 0.01) {
            console.log(`📤 Sent ${resampledBuffer.length} bytes resampled audio to OpenAI (${activeCallId})`);
          }
        }
      } catch (error) {
        console.error(`❌ Error processing/resampling audio for ${activeCallId}:`, error);
      }
    } catch (error) {
      console.error('❌ Error processing Telnyx message:', error);
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
  console.log(`🔧 Environment: RAILWAY_PUBLIC_DOMAIN=${process.env.RAILWAY_PUBLIC_DOMAIN || 'not set'}`);
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

