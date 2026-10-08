# Order Platform

Production-oriented Cloudflare Workers + Durable Objects starter for a multi-role ordering/delivery platform.

## Required architecture
- Cloudflare Worker API
- Durable Object named `OrderPlatformDatabase`
- Durable Object SQLite persistence
- WebSocket endpoint for order realtime events
- No Firebase, MongoDB, R2, file uploads, Base64, Blob storage
- Media are URL strings only

## Run
```bash
npm install
npm run dev
```

## Deploy
```bash
npx wrangler login
npm run deploy
```

The initial admin account is created automatically:
- username: `admin`
- password: `change-me-now`

Change it immediately from the admin settings/API.

This package is a strong runnable foundation. Before public commercial launch, add production secrets, rate limiting/WAF rules, verified payment integrations, audit logging, backups/export procedures, and a full automated test suite.
