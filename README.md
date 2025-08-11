# Twilio SMS Bot with Gemini AI

A Cloudflare Worker-based SMS bot that integrates with Google's Gemini AI to provide intelligent responses to SMS messages. Built for simplicity and reliability, with features like rate limiting, phone number whitelisting, and optimized responses for SMS.

## Features

- 🤖 **AI-Powered Responses**: Uses Google Gemini 2.0 Flash Lite for intelligent SMS replies
- 📱 **SMS Integration**: Seamless Twilio SMS webhook integration
- 🚀 **Cloudflare Workers**: Fast, edge-based deployment with global distribution
- 🛡️ **Security**: Phone number whitelisting and rate limiting per sender
- ⚡ **Performance**: Optimized for SMS with response length limits and timeouts
- 🔒 **Access Control**: Configurable whitelist of allowed phone numbers

## How It Works

1. User sends SMS to your Twilio number
2. Twilio forwards the message to your Cloudflare Worker via webhook
3. Worker validates the sender, checks rate limits, and calls Gemini AI
4. AI response is formatted as TwiML and sent back to Twilio
5. Twilio delivers the AI response as an SMS to the user

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Twilio account](https://www.twilio.com/try-twilio)
- [Google AI Studio API key](https://aistudio.google.com/app/apikey)
- [Node.js](https://nodejs.org/) (for local development)

## Setup

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd twilio-sms-bot
npm install -g wrangler
```

### 2. Configure Environment Variables

Create a `.dev.vars` file for local development:

```env
GOOGLE_API_KEY=your_gemini_api_key_here
ALLOWED_FROM_NUMBERS=+14155551234,+447700900123
```

**Required Variables:**
- `GOOGLE_API_KEY`: Your Google AI Studio API key for Gemini
- `ALLOWED_FROM_NUMBERS`: Comma-separated list of allowed phone numbers (leave empty to allow all)

### 3. Deploy to Cloudflare

```bash
# Login to Cloudflare
wrangler login

# Deploy
wrangler deploy
```

### 4. Configure Twilio Webhook

1. Go to your [Twilio Console](https://console.twilio.com/)
2. Navigate to Phone Numbers → Manage → Active numbers
3. Click on your phone number
4. Set the **SMS webhook** to your Worker URL:
   ```
   https://twilio-sms-bot.your-account.workers.dev
   ```
5. Set HTTP method to **POST**

## Local Development

### Run Locally

```bash
wrangler dev
```

Your worker will be available at `http://127.0.0.1:8787`

### Test Locally

```bash
# PowerShell
$body = @{
  Body = "Hello, how are you?"
  From = "+14155551234"
  To   = "+15005550006"
}
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/" -ContentType "application/x-www-form-urlencoded" -Body $body

# cURL
curl -X POST http://127.0.0.1:8787/ \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "Body=Hello, how are you?&From=%2B14155551234&To=%2B15005550006"
```

## Configuration

### Rate Limiting

- **Default**: 5 messages per minute per phone number
- **Configurable**: Modify `RATE_LIMIT_CAPACITY` and `RATE_LIMIT_REFILL_WINDOW_MS` in `src/index.js`

### System Prompt

The bot uses a built-in system prompt optimized for SMS:
> "You are a helpful assistant for old people, answer their questions in a way that is easy to understand and succinct. Keep your responses within 160 characters."

### Response Length

- **Maximum**: 1200 characters (truncated with "..." if longer)
- **SMS Optimized**: Responses are kept concise for better SMS delivery

## API Endpoints

### POST `/`

**Request Body** (form-data):
- `Body`: The user's message
- `From`: Sender's phone number
- `To`: Recipient's phone number

**Response**: TwiML XML that Twilio processes to send SMS

**Example Response**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Hello! I'm here to help. How can I assist you today?</Message>
</Response>
```

## Security Features

- **Phone Number Validation**: Only whitelisted numbers can use the service
- **Rate Limiting**: Prevents abuse with per-sender token bucket
- **Input Sanitization**: XML escaping prevents injection attacks
- **Timeout Protection**: 10-second timeout on AI API calls

## Monitoring and Logs

The worker logs important events:
- Rate limit violations
- Blocked non-whitelisted numbers
- Gemini API responses and errors
- Request processing status

View logs in the Cloudflare dashboard or via `wrangler tail`

## Troubleshooting

### Common Issues

1. **No SMS received**
   - Check if your phone number is in `ALLOWED_FROM_NUMBERS`
   - Verify Twilio webhook URL is correct
   - Check Cloudflare Worker logs

2. **Rate limited**
   - Wait 1 minute between messages
   - Check if you're sending from the same number

3. **AI not responding**
   - Verify `GOOGLE_API_KEY` is set correctly
   - Check Gemini API quota and billing

### Debug Mode

Add more logging by modifying the console.log statements in `src/index.js`

## Customization


### Add New Features

- **Conversation History**: Implement KV storage for chat context
- **Multi-language Support**: Add language detection and translation
- **Admin Commands**: Special commands for whitelist management
- **Analytics**: Track usage patterns and popular queries

## Deployment Options

### Production

```bash
wrangler deploy --env production
```

### Staging

```bash
wrangler deploy --env staging
```

