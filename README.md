# Tavari Voice Agent

Simple voice agent using Telnyx + OpenAI Realtime API, deployed on Railway.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
OPENAI_API_KEY=your_openai_key
TELNYX_API_KEY=your_telnyx_key
PORT=3000
```

### 3. Telnyx Configuration

1. Go to [Telnyx Portal](https://portal.telnyx.com/)
2. Create a **Call Control Application**
3. Set webhook URL to: `https://your-railway-url.up.railway.app/webhook`
4. Enable **Start/Stop Media Streaming**
5. Set **Answer Calls** = ON
6. Assign your phone number to this Call Control Application

### 4. Deploy to Railway

1. Create a new Railway project
2. Connect your GitHub repo (or deploy from this folder)
3. Add environment variables:
   - `OPENAI_API_KEY`
   - `TELNYX_API_KEY`
   - `PORT=3000` (Railway sets this automatically)
4. Go to **Settings → Domains**
5. Copy your public URL
6. Update Telnyx webhook URL with your Railway domain

### 5. Test

1. Call your Telnyx phone number
2. Server receives `call.initiated`
3. Server answers the call
4. OpenAI Realtime session starts
5. User speaks → OpenAI processes → Responds via TTS
6. Telnyx plays the audio back

## Monitoring

Check Railway logs to see:
- Webhook events
- OpenAI connection status
- Audio streaming events
- Errors

## Architecture

- **Telnyx**: Handles phone calls and audio streaming
- **OpenAI Realtime API**: Processes speech and generates responses
- **Railway**: Hosts the server
- **Express**: Webhook handler

Each phone call = its own OpenAI Realtime session (no shared sockets).

