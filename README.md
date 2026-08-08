# Job Tracker

Web app that reads Gmail for **real application / hiring-stage emails**, extracts company + status, and syncs a Google Sheet.

## Classification

1. **Rules first** (`src/lib/classify/rules.ts`) — reject alerts/bots; detect applied/interview/etc.; regex company/role.
2. **Optional LLM** — only runs when rules already think it’s an application (saves quota).
   - Prefer **Gemini free tier** via `GEMINI_API_KEY` ([Google AI Studio](https://aistudio.google.com/apikey))
   - Falls back to OpenAI if only `OPENAI_API_KEY` is set
   - No key → rules-only

## Sync modes (dashboard)

| Button | Lookback | Max candidates | LLM reclassify skips |
|--------|----------|----------------|----------------------|
| **Test sync (14 days)** | 14d | ~100 (2×50) | no — cheapest for trying Gemini |
| Sync new mail | history / recent | small | no |
| Full sync (90 days) | 90d | ~600 | yes |

Body sent to the LLM is capped (~1200 chars); output capped at 256 tokens.

## Setup

```bash
npm install
npx prisma migrate dev --name init
cp .env.example .env
```

Fill in:
- Google OAuth (`AUTH_GOOGLE_*`) — enable **Gmail**, **Sheets**, **Drive** APIs; add yourself as OAuth **test user**
- `GEMINI_API_KEY` from [AI Studio](https://aistudio.google.com/apikey)
- Optional: `GEMINI_MODEL=gemini-2.0-flash` (or `gemini-2.0-flash-lite` / `gemini-2.5-flash-lite` if your project has them)

```bash
npm run dev
```

Then: **Test sync (14 days)** first. Only run Full sync after you’re happy with quality.

## Scripts

- `npm run dev`
- `npm run test:classify`
- `npm run build`
