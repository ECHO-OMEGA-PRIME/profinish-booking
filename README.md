# Pro Finish Booking API

Cloudflare Worker providing the booking backend and ElevenLabs ConvoAI voice assistant integration for Pro Finish Custom Carpentry (Midland, TX). Handles appointment scheduling, customer memory, SMS notifications, and AI-powered phone conversations.

## Features

- **Appointment Booking** -- Public website booking form and ConvoAI tool-call-driven booking from voice conversations
- **Slot Availability** -- Real-time availability checking with configurable business hours (Mon-Fri 8am-5pm, Sat 9am-1pm)
- **ElevenLabs ConvoAI Integration** -- Voice AI agent for phone conversations with tool-call support (check availability, book appointments, request callbacks)
- **Infinite Customer Memory** -- Customer interaction history stored in D1 and synced to Echo Shared Brain for cross-session recall
- **SMS Notifications** -- Twilio-powered SMS alerts to both the business owner and customer on booking confirmation
- **Urgent Callback Requests** -- ConvoAI can trigger immediate callback requests via SMS when customer needs urgent attention
- **Agent Management** -- View and update ConvoAI agent configuration, knowledge base, and conversation settings
- **Test Calls** -- Initiate test calls to the ConvoAI agent for quality verification
- **Structured JSON Logging** -- All requests logged with timestamps and context

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with service status |
| `OPTIONS` | `*` | CORS preflight handler |
| `GET` | `/availability` | Check available time slots for a date range |
| `POST` | `/book` | Create a new booking (website form) |
| `GET` | `/bookings` | List all bookings (with optional date/status filters) |
| `GET` | `/bookings/:id` | Get specific booking details |
| `PUT` | `/bookings/:id` | Update booking status |
| `DELETE` | `/bookings/:id` | Cancel a booking |
| `POST` | `/convai/webhook` | ElevenLabs ConvoAI webhook (tool calls: check_availability, book_appointment, request_callback) |
| `GET` | `/convai/agent` | Get current ConvoAI agent configuration |
| `PUT` | `/convai/agent` | Update ConvoAI agent settings |
| `POST` | `/convai/test-call` | Initiate a test call to the ConvoAI agent |
| `GET` | `/customers` | List customers with interaction history |
| `GET` | `/customers/:id` | Get customer details and booking history |
| `GET` | `/settings` | Get business settings |
| `PUT` | `/settings` | Update business settings |
| `GET` | `/stats` | Booking and revenue statistics |

## Configuration

### Environment Variables (`wrangler.toml`)

```toml
[vars]
VERSION = "1.1.0"
BUSINESS_NAME = "Pro Finish Custom Carpentry"
OWNER_NAME = "Adam McLemore"
ADAM_PHONE = "+14322693446"
PROFINISH_PHONE = "+14322192586"
CONVAI_AGENT_ID = "agent_1101kkhn2wv0e1raj8zcvs0w83ry"
CONVAI_PHONE_NUMBER_ID = "phnum_9301kkhn5s38e1ta538ae93b7pja"
```

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `TWILIO_SID` | Twilio Account SID for SMS |
| `TWILIO_TOKEN` | Twilio Auth Token |
| `ELEVENLABS_API_KEY` | ElevenLabs API key for ConvoAI management |

### Bindings

| Type | Binding | Resource |
|------|---------|----------|
| D1 Database | `DB` | `profinish` (83b4b2ef) |
| KV Namespace | `CACHE` | KV (e645bf98) |
| Service | `SHARED_BRAIN` | `echo-shared-brain` |

## Deployment

```bash
cd O:\ECHO_OMEGA_PRIME\WORKERS\profinish-booking
npx wrangler deploy

# Set secrets
echo "SID" | npx wrangler secret put TWILIO_SID
echo "TOKEN" | npx wrangler secret put TWILIO_TOKEN
echo "KEY" | npx wrangler secret put ELEVENLABS_API_KEY

# Verify
curl -s https://profinish-booking.bmcii1976.workers.dev/health
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript (Hono framework)
- **Database**: Cloudflare D1 (bookings, customers, interactions, settings)
- **Cache**: Cloudflare KV (session state, rate limits)
- **Voice AI**: ElevenLabs ConvoAI (tool-call webhooks)
- **SMS**: Twilio API (booking confirmations, callback requests)
- **Memory**: Echo Shared Brain (cross-system customer context)
- **Compatibility**: `nodejs_compat` flag enabled
