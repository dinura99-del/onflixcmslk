<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules
- Automation engine lives in `src/lib/engine.server.ts` and talks to the external OnFlix Supabase via service-role secrets; dashboard server functions and `/api/public/cron/*` both gate on `CRON_SECRET`, because the admin has no separate login.
- Keep Gemini subtitle translation in `src/lib/gemini-polish.server.ts` as a direct English→Sinhala pipeline using the user-owned multi-key REST pool: send only cue id + English text in batches, map replies back by id, re-ask only bad/missing ids, then fall back per line to Google GTX, because the old draft/audit/hard-gate layers burned quota and blocked whole subtitles.
- Quota handling lives in the key/model pool: a daily-quota 429 (or repeated 429s/timeouts) parks that key for that model, and when every key is parked the next model in `modelPriority()` is used; Flash-Lite is first because measured free-tier Flash quotas are ~20 requests/key/day.
- `scripts/worker.ts` runs under Node in GitHub Actions (`.github/workflows/process-queue.yml`), not in the Worker runtime, so it may use Node-only APIs; keep shared engine code in `src/lib` runtime-neutral.
- The PWA service worker (`public/sw.js`) is registered only on the published build outside iframes; dev/preview unregisters it, and it caches only hashed `/assets/` files and icons, because cached app modules caused hydration mismatches.
- Automatic runs gate TV episodes sequentially (`previousEpisodeBlocker` in `src/lib/engine.server.ts`): an episode waits while its previous episode is queued but unpublished, stale `processing` jobs are recovered after 45 min, and Manual runs bypass the gate, because episodes previously published out of order (E7 before a stuck E6).
- Sinhala output is whitelisted to Sinhala, Latin and script-neutral symbols: replies with whole words in other alphabets are re-asked and every SRT save passes `sanitizeSinhalaSrt`, because Gemini leaks Telugu/Bengali/Korean/etc. letters.
- When translation stops only on quota, `polishCues` throws a temporary `FinalReviewError` with the finished lines; the job saves them as a storage checkpoint, is marked `[QA_WAITING]`, and resumes from it 30 minutes later; more than ~3% English spoken lines goes to `[NEEDS_REVIEW]` instead of publishing.
- Subtitle translation never falls back to Groq or a whole-SRT AI call: the chain is Gemini pool → Google GTX → MyMemory, because the old Groq models were decommissioned and whole-SRT replies got cut off on long subtitles.
