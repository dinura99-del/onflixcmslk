# Onflix Automate

Build the OnFlix Subtitle Automation Admin Dashboard & Backend Engine.

Key Requirements:
1. Design & UI/UX:
   - Dark theme, ultra-clean, minimal, cool, modern aesthetic.
   - NO glow effects, NO heavy drop shadows, NO harsh borders.
   - Soft rounded corners (rounded-xl / rounded-2xl), clean typography, high legibility, effortless navigation.

2. Trending & Quality Filters (avoiding short films and junk):
   - Movie filter: minimum runtime >= 60 minutes (excludes short films, clips, teasers).
   - Popularity threshold: configurable (default popularity score >= 15.0 or 20.0, vote_count >= 5).
   - Filter out talk shows, news, reality shows for TV.
   - Focus on trending and upcoming mainstream movies & series.

3. Two-Stage Queue & Automation Architecture:
   - Stage 1: TMDB Scanner - Discovers upcoming & trending releases (+30 days), skips items that already have completed Sinhala subtitles in OnFlix database, inserts new jobs as 'upcoming' or 'waiting_embed' into Supabase queue table `subtitle_automation_jobs`.
   - Stage 2: Release Processor - Picks items where release_date <= today:
     * EmbedMaster availability check (probe sources_count > 0). If not available -> status 'waiting_embed'.
     * Wyzie English SRT fetch. If not available -> status 'waiting_subtitle'.
     * AI Sinhala Translation using Groq (openai/gpt-oss-120b) with Gemini (gemini-2.5-flash) fallback.
     * Supabase Storage upload for Sinhala .srt.
     * Upsert into OnFlix `content` (for movies) and `episodes` (with content_id, season_number, episode_number) and update `content.seasons`.
     * Optional HMAC cache revalidation call.
     * Status transitions: upcoming -> waiting_embed -> waiting_subtitle -> processing -> completed / failed.

4. Dashboard Views:
   - Overview & Metrics: Total jobs, Upcoming, Waiting for Video, Waiting for Subtitle, Processing, Completed, Failed.
   - Live Queue Table: Filter by status, search by title or TMDB ID, view attempts, next retry time, release date, error log, and preview translated subtitles.
   - Manual Action Controls: "Scan Trending Now" and "Process Batch Now" with real-time progress feedback.
   - Filter & Scanner Settings: Adjust min popularity, min runtime, lookahead days (30 days), max batch size, retry intervals.
   - API & Cron Webhook Settings: Displays public endpoints (/api/cron/scan and /api/cron/process) with secure CRON_SECRET authentication for external cron services (e.g. cron-job.org).
   - SQL Migration view with copy button for Supabase table setup.

5. API Routes:
   - Backend routes/functions for `/api/cron/scan` and `/api/cron/process` protected by Bearer CRON_SECRET authorization.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://onflix-automate.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/979e4b8e-4add-4190-ab53-abf3bf96b77a).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

AI Co-Pilot public web search requires the server-side `TAVILY_API_KEY`. Set it in the local `.env` file or in the deployment platform's secret settings; never expose it with a `VITE_` prefix.
