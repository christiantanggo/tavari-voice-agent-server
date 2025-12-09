# Voximplant Migration Guide

## Overview
Migrating from Telnyx to Voximplant for the Tavari Voice Agent.

## Key Differences

### Telnyx (Current)
- Webhook-based: Telnyx sends webhooks to our server
- Call Control API: HTTP API calls to answer/speak/stream
- Media Streaming: WebSocket connection for bidirectional audio
- Format: JSON webhooks, PCM16 audio (8kHz)

### Voximplant (New)
- VoxEngine: Serverless JavaScript scenarios OR HTTP webhooks
- Management API: For account/phone number management
- Media Streaming: WebSocket or HTTP-based audio streaming
- Format: JSON webhooks, PCM16 audio (8kHz or 16kHz)

## Migration Steps

### 1. Environment Variables
Replace:
- `TELNYX_API_KEY` → `VOXIMPLANT_ACCOUNT_ID`, `VOXIMPLANT_API_KEY`
- `TELNYX_CONNECTION_ID` → Not needed (Voximplant uses applications)

### 2. Webhook Handler
- Replace `/webhook` endpoint to handle Voximplant webhook format
- Voximplant events: `CallStarted`, `CallConnected`, `CallDisconnected`
- Update event parsing logic

### 3. Call Control
- Replace `answerCall()` - Voximplant calls are auto-answered in scenarios
- Replace `startMediaStream()` - Voximplant uses different streaming approach
- Update audio streaming WebSocket format

### 4. Audio Format
- Voximplant supports 8kHz and 16kHz PCM16
- May need to adjust resampling logic
- Update WebSocket message format

## Voximplant Setup Required

1. Create Voximplant account
2. Create Application in Voximplant
3. Configure webhook URL in application settings
4. Purchase/assign phone number
5. Set up scenario or webhook handler

## Resources
- Voximplant Docs: https://voximplant.com/docs/
- Management API: https://voximplant.com/docs/guides/management-api
- AI Integration: https://voximplant.com/docs/guides/ai

