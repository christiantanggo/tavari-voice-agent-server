// VoxEngine Scenario for Tavari Voice Agent
// Final version with Railway URL configured

const RAILWAY_URL = "tavari-voice-agent-server-production.up.railway.app";
const WEBHOOK_URL = `https://${RAILWAY_URL}/webhook`;
const MEDIA_STREAM_WS = `wss://${RAILWAY_URL}/media-stream-ws`;

VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
  var call = e.call;
  var callId = call.callId();
  var callerId = call.callerid();
  var calleeId = call.number();
  
  Logger.write("📞 Incoming call: " + callId);
  
  // Send webhook to Railway - Call Started
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
  
  // Handle call connected
  call.addEventListener(CallEvents.Connected, function() {
    Logger.write("✅ Call connected: " + callId);
    
    sendWebhook(WEBHOOK_URL, {
      event: "CallConnected",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
    
    // Set up media streaming
    setupMediaStreaming(call, callId);
  });
  
  // Handle call disconnect
  call.addEventListener(CallEvents.Disconnected, function() {
    Logger.write("📴 Call disconnected: " + callId);
    
    sendWebhook(WEBHOOK_URL, {
      event: "CallDisconnected",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
  });
});

function sendWebhook(url, data) {
  var httpRequest = Net.httpRequest(url, {
    method: "POST",
    headers: [["Content-Type", "application/json"]],
    postData: JSON.stringify(data)
  });
  
  httpRequest.addEventListener(NetEvents.HttpResponse, function(e) {
    if (e.code === 200) {
      Logger.write("✅ Webhook sent: " + data.event);
    } else {
      Logger.write("❌ Webhook failed: " + e.code);
    }
  });
  
  httpRequest.addEventListener(NetEvents.HttpError, function(e) {
    Logger.write("❌ Webhook error: " + e.text);
  });
}

function setupMediaStreaming(call, callId) {
  var ws = Net.WebSocket(MEDIA_STREAM_WS + "?call_id=" + callId);
  
  ws.addEventListener(WebSocketEvents.Connected, function() {
    Logger.write("🔌 WebSocket connected for " + callId);
    
    // Stream audio from call to WebSocket
    // Voximplant sends PCM audio via CallEvents.PCM
    call.addEventListener(CallEvents.PCM, function(e) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // Convert PCM buffer to base64
          var buffer = e.buffer;
          var audioBase64 = "";
          
          // Handle different buffer types
          if (buffer instanceof ArrayBuffer) {
            var uint8Array = new Uint8Array(buffer);
            for (var i = 0; i < uint8Array.length; i++) {
              audioBase64 += String.fromCharCode(uint8Array[i]);
            }
          } else if (buffer instanceof Uint8Array) {
            for (var i = 0; i < buffer.length; i++) {
              audioBase64 += String.fromCharCode(buffer[i]);
            }
          } else {
            // Try to convert to array
            for (var i = 0; i < buffer.length; i++) {
              audioBase64 += String.fromCharCode(buffer[i]);
            }
          }
          
          audioBase64 = btoa(audioBase64);
          
          ws.send(JSON.stringify({
            event: "media",
            media: { payload: audioBase64 }
          }));
        } catch (error) {
          Logger.write("❌ Error encoding audio: " + error);
        }
      }
    });
    
    // Handle audio from WebSocket (Railway -> Voximplant)
    ws.addEventListener(WebSocketEvents.Message, function(e) {
      try {
        var msg = JSON.parse(e.text);
        if (msg.event === "media" && msg.media && msg.media.payload) {
          var audioData = atob(msg.media.payload);
          var buffer = new Uint8Array(audioData.length);
          for (var i = 0; i < audioData.length; i++) {
            buffer[i] = audioData.charCodeAt(i);
          }
          
          // Send audio to caller
          // Note: Voximplant API might use call.sendMedia() or call.sendMediaTo()
          // If sendMedia() doesn't work, try: call.sendMediaTo(ws) or other methods
          call.sendMedia(buffer);
        }
      } catch (error) {
        Logger.write("❌ WebSocket message error: " + error);
      }
    });
    
    ws.addEventListener(WebSocketEvents.Error, function(e) {
      Logger.write("❌ WebSocket error: " + e.text);
    });
    
    ws.addEventListener(WebSocketEvents.Disconnected, function() {
      Logger.write("🔌 WebSocket disconnected for " + callId);
    });
  });
  
  ws.addEventListener(WebSocketEvents.Error, function(e) {
    Logger.write("❌ WebSocket connection error: " + e.text);
  });
}

