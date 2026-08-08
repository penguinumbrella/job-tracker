# Job Tracker

Web app that reads your Gmail for job-application status emails, groups them into applications, and syncs a live Google Sheet with deep links back to each message.

## Features

- Google sign-in with Gmail readonly + Sheets access
- Hybrid classification (ATS/rules first, optional OpenAI extraction)
- Application status = latest related email (or a pinned override)
- Per-user Google Sheet (`Applications` + `Emails` tabs)
- Manual sync + cron poll; optional Gmail Pub/Sub push for near-real-time updates

## Setup

### 1. Install & database

```bash
npm install
npx prisma migrate dev --name init
```

### 2. Google Cloud

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **Gmail API** and **Google Sheets API**
3. Configure OAuth consent screen ( External / testing is fine for personal use)
4. Create OAuth **Web** client credentials
5. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
6. Copy Client ID and Client Secret into `.env`

### 3. Environment

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Purpose |
|----------|----------|---------|
| `AUTH_SECRET` | yes | `npx auth secret` or any long random string |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | yes | OAuth client |
| `OPENAI_API_KEY` | no | Better company/role/status extraction |
| `GMAIL_PUBSUB_TOPIC` | no | Push sync (`projects/…/topics/…`) |
| `CRON_SECRET` | for cron | Bearer token for `/api/cron/sync` |

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with Google, then **Full sync (90 days)**.

## Continuous updates

1. **Manual:** Dashboard buttons (`Full sync` / `Sync new mail`)
2. **Poll (recommended baseline):** Hit `GET /api/cron/sync` every ~10 minutes with `Authorization: Bearer $CRON_SECRET` (Vercel Cron is preconfigured in `vercel.json`; set `CRON_SECRET` in the host env). On Vercel, also protect the cron route or rely on Vercel’s cron header in production if you extend the handler.
3. **Push (near real-time):** Create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` publish rights, set `GMAIL_PUBSUB_TOPIC`, expose `POST /api/webhooks/gmail`, then call `POST /api/watch` once after login (watch renews via cron).

## Statuses

`applied` · `under_review` · `assessment` · `interview` · `offer` · `rejected` · `withdrawn` · `unknown`

## Stack

Next.js · Auth.js · Prisma (SQLite locally) · Gmail API · Google Sheets API · OpenAI (optional)
