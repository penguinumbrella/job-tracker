# Job Tracker

Web app that reads Gmail for **real application / hiring-stage emails**, extracts company + status, and syncs a Google Sheet.

## What counts as an application

Kept:
- “We received your application…”, thank-you-for-applying, under review, interview, assessment, offer, rejection

Rejected:
- Job alerts / digests / “new openings hiring”
- Apply bots / finish-applying reminders
- Emails with no extractable company name

Company names are parsed from body phrases like `We have received your application at [Company]` and from the From display name when needed.

## Setup

```bash
npm install
npx prisma migrate dev --name init
cp .env.example .env   # fill Google OAuth (+ optional OPENAI_API_KEY)
npm run dev
```

Enable on the same GCP project: **Gmail API**, **Google Sheets API**, **Google Drive API**.  
Add yourself as an OAuth **test user** while the consent screen is in Testing.

## Scripts

- `npm run dev` — local server
- `npm run test:classify` — rules unit checks
- `npm run build` — production build

See `.env.example` for Auth, OpenAI, cron, and Pub/Sub variables.
