# ShopBridge pilot — GPT matcher over a frozen QA library

A small Node app for piloting the donation chatbot. Free text goes to OpenAI, which **only chooses a
matching answer id and a 1–5 closeness band** — it never writes the answer. The backend looks up the
frozen answer and stitches the band's neutral wrapper (band 5 → a refusal). Substance stays controlled.

## Files

| File | What it is |
|---|---|
| `engine_data.json` | The library: 76 answers, 7 chips, wrapper bands, 3 refusal tiers, tag legend (generated from `QA_draftv8.xlsx`). |
| `matcher.js` | Builds the matcher prompt + catalog, calls OpenAI, returns `{matched_id, band}`, stitches the wrapper. |
| `server.js` | Express server: serves `public/` and `POST /api/v4/ask`. Logs every turn to `logs.jsonl`. |
| `test_matcher.js` | Batch-runs `stress_test.json` and prints how each question routes. |
| `public/index.html` | The donation-page frontend (calls `/api/v4/ask`). |
| `.env.example` | Template for your key + model. |
| `render.yaml` | Render web-service config. |

## Run locally

```bash
npm install
cp .env.example .env        # then edit .env and paste your OPENAI_API_KEY
npm start                   # serves http://localhost:3000
```

Open http://localhost:3000 and chat. (The card images referenced by the frontend are optional — a
missing image won't affect matching.)

## Audit match quality before deploying

```bash
npm test                    # runs stress_test.json, prints question -> matched_id, band
```

Review the output (and `stress_test_results.json`). Add more questions to `stress_test.json` — the full
~250-item stress list belongs here. Look for: on-scope questions landing on band 5 (false refusals),
off-scope questions NOT at band 5 (leakage), and any obviously wrong `matched_id`. Tune by editing the
canonical `question` phrasings or the rubric in `engine_data.json` / `matcher.js`.

## Choosing the model

Set `OPENAI_MODEL` in `.env`. A small/fast model is the right default for matching. To test whether a
bigger model helps, change `OPENAI_MODEL` and re-run `npm test` on the same set, then compare — decide
on evidence, not assumption. If your model rejects `temperature`, remove that line in `matcher.js`.

## Deploy to Render

1. Push this folder to a GitHub repo (`.env` is git-ignored — your key never leaves your machine).
2. Render → **New → Web Service** → pick the repo. It reads `render.yaml`.
3. In the Render dashboard, add the **`OPENAI_API_KEY`** environment variable (and `OPENAI_MODEL`).
4. Deploy → you get a public URL. Every `git push` auto-redeploys.

## Notes / cautions

- **Key safety:** the key is only ever a server-side env var. If it leaks, rotate it in OpenAI.
- **Render free tier sleeps** (cold start ~30s) and its **disk is ephemeral** — `logs.jsonl` is wiped on
  redeploy/restart. Export logs before redeploying, or add a small DB (e.g. Supabase) for a real pilot.
- **Chips:** in this pilot, chip buttons route through the matcher like any text (they'll hit band 1 and
  return the full answer). If you want chips to serve the short verbatim chip summaries instead, have the
  frontend send a `chipId` and we'll short-circuit it in `server.js`.
- **Arm framing:** answer content is identical across arms; the Generic-vs-TCA difference is the header
  label/attribution in the frontend, not the answers.
