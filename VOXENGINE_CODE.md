# VoxEngine Scenario Code for Tavari Voice Agent

## Instructions

1. **Replace `YOUR_RAILWAY_URL`** with your actual Railway domain
   - Example: `tavari-voice-agent-server-production.up.railway.app`

2. **Paste this code into the VoxEngine editor**

3. **Save and activate the scenario**

## Code

```javascript
// VoxEngine Scenario for Tavari Voice Agent
// Replace YOUR_RAILWAY_URL with your Railway domain

const RAILWAY_URL = "YOUR_RAILWAY_URL";
const WEBHOOK_URL = `https://${RAILWAY_URL}/webhook`;
const MEDIA_STREAM_WS = `wss://${RAILWAY_URL}/media-stream-ws`;

VoxEngine.addEventListener(AppEvents.CallAlerting, (e) => {
  const call = e.call;
  const callId = call.callId();
  const callerId = call.callerid();
  const calleeId = call.number();
  
  Logger.write(`📞 Incoming call: ${callId} from ${callerId} to ${calleeId}`);
  
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
  call.addEventListener(CallEvents.Connected, () => {
    Logger.write(`✅ Call connected: ${callId}`);
    
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
  call.addEventListener(CallEvents.Disconnected, () => {
    Logger.write(`📴 Call disconnected: ${callId}`);
    
    sendWebhook(WEBHOOK_URL, {
      event: "CallDisconnected",
      callId: callId,
      sessionId: callId,
      timestamp: new Date().toISOString()
    });
  });
});

function sendWebhook(url, data) {
  const httpRequest = Net.httpRequest(url, {
    method: "POST",
    headers: [["Content-Type", "application/json"]],
    postData: JSON.stringify(data)
  });
  
  httpRequest.addEventListener(NetEvents.HttpResponse, (e) => {
    if (e.code === 200) {
      Logger.write(`✅ Webhook sent: ${data.event}`);
    } else {
      Logger.write(`❌ Webhook failed: ${e.code}`);
    }
  });
}

function setupMediaStreaming(call, callId) {
  const ws = Net.WebSocket(MEDIA_STREAM_WS + `?call_id=${callId}`);
  
  ws.addEventListener(WebSocketEvents.Connected, () => {
    Logger.write(`🔌 WebSocket connected for ${callId}`);
    
    // Stream audio from call to WebSocket
    call.addEventListener(CallEvents.PCM, (e) => {
      if (ws.readyState === WebSocket.OPEN) {
        const audioBase64 = btoa(String.fromCharCode(...new Uint8Array(e.buffer)));
        ws.send(JSON.stringify({
          event: "media",
          media: { payload: audioBase64 }
        }));
      }
    });
    
    // Handle audio from WebSocket
    ws.addEventListener(WebSocketEvents.Message, (e) => {
      try {
        const msg = JSON.parse(e.text);
        if (msg.event === "media" && msg.media?.payload) {
          const audioData = atob(msg.media.payload);
          const buffer = new Uint8Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) {
            buffer[i] = audioData.charCodeAt(i);
          }
          call.sendMedia(buffer);
        }
      } catch (error) {
        Logger.write(`❌ WebSocket message error: ${error}`);
      }
    });
  });
}
```

## Notes

- Replace `YOUR_RAILWAY_URL` with your actual Railway domain
- The code handles call events and sends webhooks to your Railway server
- Audio is streamed bidirectionally via WebSocket
- Check Voximplant logs if you encounter issues

