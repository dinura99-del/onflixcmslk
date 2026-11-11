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
- Keep Gemini subtitle post-editing in `src/lib/gemini-polish.server.ts`, using the explicitly requested user-owned multi-key REST pool; dynamically scale workers based on available keys without hardcoded limits, validate complete ID-mapped text before publishing, and never send timestamps to the model, so credentials stay server-only and dialogue timing stays immutable.
- Keep overload recovery inside the Gemini request helper, bounded to one retry per model and only HTTP 503, with abortable waits and the same key/payload, so Manual and Auto recover identically without bypassing quota or access errors.
- `scripts/worker.ts` runs under Node in GitHub Actions (`.github/workflows/process-queue.yml`), not in the Worker runtime, so it may use Node-only APIs; keep shared engine code in `src/lib` runtime-neutral.
- The PWA service worker (`public/sw.js`) is registered only on the published build outside iframes; dev/preview unregisters it, and it caches only hashed `/assets/` files and icons, because cached app modules caused hydration mismatches.
- Sinhala output is whitelisted to Sinhala, Latin and script-neutral symbols: polish rejects raw replies containing other alphabets (so they are re-translated) and every SRT save passes `sanitizeSinhalaSrt`, because Gemini leaks Telugu/Bengali/Korean/etc. letters that transliteration alone can turn into gibberish.
- Subtitle translation is two-stage: a free Google GTX draft (`googleDraftTranslation` in `src/lib/engine.server.ts`) is passed as the base to `polishCues`; untranslated draft lines are blanked so Gemini translates them fresh, and a failed or mostly-unusable draft falls back to direct Gemini, because the draft saves Gemini quota (trivial lines skip AI) and gives a Sinhala fallback when a chunk fails.
- Before publishing, `polishCues` runs a full English-vs-Sinhala review of every spoken line and a hard gate (`findUntranslatedCues`): failed chunks are retried in groups of 5, and any cue with real English words still lacking Sinhala blocks publishing, because silent English fallbacks previously reached OnFlix. Only wordless music cues (e.g. "♪♪") are left untranslated; lyrics and sound tags are translated.
- Automatic runs gate TV episodes sequentially (`previousEpisodeBlocker` in `src/lib/engine.server.ts`): an episode waits while its previous episode is queued but unpublished, stale `processing` jobs are recovered after 45 min, and Manual runs bypass the gate, because episodes previously published out of order (E7 before a stuck E6).
- When leftover translation or final Gemini review stops only on quota/overload, reuse `[QA_WAITING]` and its 30-minute storage checkpoint retry; cached-only runs must still repair leftovers and complete semantic QA, so cached work never bypasses publication gates.
- Small-group retries share polish-worker cooldowns, rotate across the entire configured pool for at most two passes, and classify only wholly temporary failures as retryable; strict leftover dialogue validation excludes Latin letters but preserves markup, so names use Sinhala phonetics without quota failures discarding completed cues.
