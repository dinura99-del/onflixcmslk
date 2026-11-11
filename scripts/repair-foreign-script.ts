/**
 * One-off repair for published Sinhala subtitles that contain letters from other alphabets
 * (Telugu, Bengali, Korean, Hebrew, Ethiopic, Thai …) leaked by the AI translator.
 *
 * For every affected line it asks Gemini to rewrite the line in pure Sinhala (using the English line
 * when the original English subtitle can be matched by timestamp). Timestamps and cue numbers are never
 * sent to or changed by the AI. Lines Gemini cannot fix get the letter-by-letter clean-up instead.
 *
 *   npx tsx scripts/repair-foreign-script.ts            # dry run: report only
 *   npx tsx scripts/repair-foreign-script.ts --apply    # upload repaired files
 *   npx tsx scripts/repair-foreign-script.ts --apply movies/155.si.srt   # just one file
 *
 * A file is saved only when Gemini fixes every damaged line (add --allow-cleanup to override); the
 * original is kept once at backup/<path> in the same bucket before it is replaced.
 */
import fs from "node:fs";
import path from "node:path";

try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (typeof (process as any).loadEnvFile === "function" && fs.existsSync(envPath)) (process as any).loadEnvFile(envPath);
} catch { /* ignore */ }

import { buildSrt, cleanSrt, db, fetchEnglishSrt, getSettings, parseSrt } from "../src/lib/engine.server";
import { cleanSinhalaText, fixForeignScript, generatePolish, geminiKeys, hasForeignScript, RateLimitError } from "../src/lib/gemini-polish.server";

const apply = process.argv.includes("--apply");
// By default a file is only saved when Gemini re-wrote every damaged line; --allow-cleanup also saves
// files where some lines only got the letter clean-up (which can leave a gap where a foreign word was).
const allowCleanup = process.argv.includes("--allow-cleanup");
let rateLimitedBatches = 0;
const only = process.argv.slice(2).filter((a) => a.endsWith(".srt"));
const sb = db();
const s = await getSettings();
const bucket = sb.storage.from(s.bucket);
const keys = geminiKeys();
let keyIdx = 0;

async function list(prefix: string): Promise<string[]> {
  const { data, error } = await bucket.list(prefix, { limit: 1000 });
  if (error) throw error;
  const out: string[] = [];
  for (const f of data ?? []) {
    const p = `${prefix}/${f.name}`;
    if (f.id) { if (p.endsWith(".si.srt")) out.push(p); } else out.push(...await list(p));
  }
  return out;
}

function jobFromPath(p: string) {
  const movie = p.match(/^movies\/(\d+)\.si\.srt$/);
  if (movie) return { media_type: "movie", tmdb_id: Number(movie[1]) };
  const tv = p.match(/^tv\/(\d+)\/s(\d+)e(\d+)\.si\.srt$/);
  if (tv) return { media_type: "tv", tmdb_id: Number(tv[1]), season_number: Number(tv[2]), episode_number: Number(tv[3]) };
  return null;
}

async function englishByTime(p: string): Promise<Map<string, string>> {
  const job = jobFromPath(p);
  if (!job) return new Map();
  const raw = await fetchEnglishSrt(job, s).catch(() => null);
  if (!raw) return new Map();
  return new Map(parseSrt(cleanSrt(raw).srt).map((c) => [c.time, c.text]));
}

async function repairFile(p: string) {
  const original = await (await bucket.download(p)).data!.text();
  if (!hasForeignScript(original)) return { p, affected: 0, ai: 0, fallback: 0 };
  const cues = parseSrt(original);
  const bad = cues.map((c, i) => ({ c, i })).filter(({ c }) => hasForeignScript(c.text));
  const english = keys.length ? await englishByTime(p) : new Map<string, string>();
  let ai = 0, fallback = 0;
  // Lines still waiting for a clean AI rewrite. With the English line we translate fresh (copying the damaged
  // Sinhala is what spreads the leak); without it, Gemini polishes the letter-cleaned Sinhala.
  let pending = bad.map(({ c, i }) => ({ c, i, en: english.get(c.time) ?? "" }));
  for (let attempt = 0; attempt < 4 && keys.length && pending.length; attempt++) {
    const failed: typeof pending = [];
    for (let start = 0; start < pending.length; start += 15) {
      const batch = pending.slice(start, start + 15);
      const targets = batch.map(({ c, i, en }) => ({ id: i + 1, en, si: en ? "" : fixForeignScript(c.text) }));
      const key = keys[keyIdx++ % keys.length]!;
      let byId = new Map<number, string>();
      try {
        const raw = await generatePolish(key, targets, [], new AbortController().signal);
        const parsed = JSON.parse(raw) as { cues?: { id: number; text: string }[] };
        // Judge the raw reply: any other-alphabet letter means Gemini drifted into another language, so retry.
        byId = new Map((parsed.cues ?? []).filter((x) => typeof x?.text === "string" && !hasForeignScript(x.text)).map((x) => [x.id, cleanSinhalaText(x.text)]));
      } catch (e) {
        if (e instanceof RateLimitError) {
          rateLimitedBatches++;
          await new Promise((r) => setTimeout(r, Math.max(e.retryAfterMs, 8000)));
        } else {
          if (attempt === 3) console.log(`  ${p}: AI batch failed (${(e as Error).message})`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      for (const item of batch) {
        const text = byId.get(item.i + 1);
        if (process.env.REPAIR_DEBUG && text) console.log(`    EN: ${item.en.replace(/\n/g, " / ")}\n    WAS: ${item.c.text.replace(/\n/g, " / ")}\n    NOW: ${text.replace(/\n/g, " / ")}`);
        if (text && (text.match(/[\u0D80-\u0DFF]/g)?.length ?? 0) >= Math.min(4, item.en.length) && !hasForeignScript(text) && !/-->/.test(text)) { item.c.text = text; ai++; }
        else failed.push(item);
      }
    }
    pending = failed;
  }
  const matched = bad.filter(({ c }) => english.has(c.time)).length;
  if (pending.length && !allowCleanup) {
    return { p, affected: bad.length, ai, fallback: 0, skipped: pending.length, englishMatched: matched > 0, matched, sample: [] as string[] };
  }
  for (const { c } of pending) { c.text = fixForeignScript(c.text); fallback++; }
  const repaired = buildSrt(cues);
  if (hasForeignScript(repaired)) throw new Error(`${p}: still contains other-language letters`);
  if (apply) {
    // Keep the untouched original once, so a repair can always be undone.
    const backupPath = `backup/${p}`;
    const exists = await bucket.download(backupPath).then((r) => !!r.data).catch(() => false);
    if (!exists) {
      const b = await bucket.upload(backupPath, new Blob([original], { type: "application/x-subrip" }), { upsert: false, contentType: "application/x-subrip" });
      if (b.error) throw new Error(`${p}: backup failed — ${b.error.message}; not changing the file`);
    }
    const up = await bucket.upload(p, new Blob([repaired], { type: "application/x-subrip" }), { upsert: true, contentType: "application/x-subrip", cacheControl: "60" });
    if (up.error) throw new Error(`${p}: upload failed — ${up.error.message}`);
  }
  return { p, affected: bad.length, ai, fallback, skipped: 0, englishMatched: matched > 0, matched, sample: bad.slice(0, 2).map(({ c }) => c.text) };
}

const files = only.length ? only : [...await list("movies"), ...await list("tv")];
console.log(`[repair] ${apply ? "APPLY" : "DRY RUN"} — ${files.length} file(s), ${keys.length} Gemini key(s)`);
let total = 0;
for (const p of files) {
  const r = await repairFile(p);
  if (!r.affected) continue;
  total += r.affected;
  if (r.skipped) { console.log(`[repair] ${p}: ${r.affected} line(s) — SKIPPED, Gemini could not fix ${r.skipped} line(s) (file left unchanged; re-run later)`); continue; }
  console.log(`[repair] ${p}: ${r.affected} line(s) — ${r.ai} re-written by AI, ${r.fallback} letter clean-up${"englishMatched" in r && !r.englishMatched ? " (no English match)" : ""}`);
  if ("sample" in r) for (const line of r.sample ?? []) console.log(`           now: ${line.replace(/\n/g, " / ")}`);
}
console.log(`[repair] done — ${total} damaged line(s) found${rateLimitedBatches ? `; ${rateLimitedBatches} batch(es) hit the Gemini rate limit` : ""}`);
