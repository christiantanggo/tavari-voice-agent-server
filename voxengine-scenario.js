// VoxEngine Scenario for Tavari Voice Agent
// This handles incoming calls and sends webhooks to Railway server

// Replace YOUR_RAILWAY_URL with your actual Railway domain
// Example: tavari-voice-agent-server-production.up.railway.app
const RAILWAY_URL = "YOUR_RAILWAY_URL";
const WEBHOOK_URL = `https://${RAILWAY_URL}/webhook`;
const MEDIA_STREAM_WS = `wss://${RAILWAY_URL}/media-stream-ws`;

VoxEngine.addEventListener(AppEvents.CallAlerting, (e) => {
  const call = e.call;
  const callId = call.callId();
  const callerId = call.callerid();
  const calleeId = call.number();
  
  Logger.write(`📞 Incoming call: ${callId} from ${callerId} to ${calleeId}`);
  
  // Send webhook to Railway server - Call Started
  sendWebhook(WEBHOOK_URL, {
    event: "CallStarted",
    callId: callId,
    sessionId: callId,
    callerId: callerId,
    calleeId: calleeId,
    timestamp: new Date().toISOString()
  });
  
  // Answer the call
  call.answer();
  
  // Send webhook - Call Connected
  VoxEngine.addEventListener(CallEvents.Connected, () => {
    Logger.write(`✅ Call connected: ${callId}`);
    
    sendWebhook(WEBHOOK_URL, {
      event: "CallConnected",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
    
    // Set up media streaming to Railway WebSocket
    setupMediaStreaming(call, callId);
  });
  
  // Handle call disconnect
  VoxEngine.addEventListener(CallEvents.Disconnected, () => {
    Logger.write(`📴 Call disconnected: ${callId}`);
    
    sendWebhook(WEBHOOK_URL, {
      event: "CallDisconnected",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
  });
});

/**
 * Send webhook to Railway server
 */
function sendWebhook(url, data) {
  const httpRequest = Net.httpRequest(url, {
    method: "POST",
    headers: [
      ["Content-Type", "application/json"]
    ],
    postData: JSON.stringify(data)
  });
  
  httpRequest.addEventListener(NetEvents.HttpResponse, (e) => {
    if (e.code === 200) {
      Logger.write(`✅ Webhook sent successfully: ${data.event}`);
    } else {
      Logger.write(`❌ Webhook failed: ${e.code} - ${e.text}`);
    }
  });
  
  httpRequest.addEventListener(NetEvents.HttpError, (e) => {
    Logger.write(`❌ Webhook error: ${e.text}`);
  });
}

/**
 * Set up media streaming to Railway WebSocket
 * This streams audio bidirectionally between Voximplant and Railway server
 */
function setupMediaStreaming(call, callId) {
  // Create WebSocket connection to Railway server
  const ws = Net.WebSocket(MEDIA_STREAM_WS + `?call_id=${callId}&session_id=${callId}`);
  
  ws.addEventListener(WebSocketEvents.Connected, () => {
    Logger.write(`🔌 WebSocket connected to Railway for ${callId}`);
    
    // Send webhook - Media stream started
    sendWebhook(WEBHOOK_URL, {
      event: "MediaStreamStarted",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
    
    // Set up audio streaming from call to WebSocket
    call.addEventListener(CallEvents.PCM, (e) => {
      // Send audio data to Railway WebSocket
      // Voximplant sends PCM data - format depends on configuration
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary or JSON depending on Railway server expectations
        // Try JSON format first: { event: "media", media: { payload: "<base64>" } }
        const audioBase64 = btoa(String.fromCharCode(...new Uint8Array(e.buffer)));
        const message = JSON.stringify({
          event: "media",
          media: {
            payload: audioBase64
          }
        });
        ws.send(message);
      }
    });
    
    // Handle audio from WebSocket (Railway -> Voximplant)
    ws.addEventListener(WebSocketEvents.Message, (e) => {
      try {
        const message = JSON.parse(e.text);
        if (message.event === "media" && message.media && message.media.payload) {
          // Decode base64 audio and play to caller
          const audioData = atob(message.media.payload);
          const audioBuffer = new Uint8Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) {
            audioBuffer[i] = audioData.charCodeAt(i);
          }
          // Play audio to caller
          call.sendMedia(audioBuffer);
        }
      } catch (error) {
        Logger.write(`❌ Error processing WebSocket message: ${error}`);
      }
    });
  });
  
  ws.addEventListener(WebSocketEvents.Error, (e) => {
    Logger.write(`❌ WebSocket error: ${e.text}`);
  });
  
  ws.addEventListener(WebSocketEvents.Disconnected, () => {
    Logger.write(`🔌 WebSocket disconnected for ${callId}`);
    
    sendWebhook(WEBHOOK_URL, {
      event: "MediaStreamEnded",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
  });
}

