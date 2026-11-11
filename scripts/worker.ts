/**
 * Standalone Queue Worker for GitHub Actions / CLI execution.
 *
 * Runs `runProcess()` from engine.server.ts with real-time console logging.
 * Can be triggered on a schedule (every 15 min), via repository_dispatch,
 * or manually via workflow_dispatch.
 */
import fs from "node:fs";
import path from "node:path";

// Auto-load local .env if present (when running outside GitHub Actions)
try {
  if (typeof (process as any).loadEnvFile === "function") {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      (process as any).loadEnvFile(envPath);
    }
  }
} catch {
  // ignore
}

import { runProcess } from "../src/lib/engine.server";
import { geminiKeys } from "../src/lib/gemini-polish.server";

async function main() {
  const isForce = process.argv.includes("--force") || process.env.FORCE === "true" || process.env.FORCE === "1";
  console.log(`[Worker] Starting OnFlix Subtitle Worker (force: ${isForce})…`);
  console.log(`[Worker] Environment: Node ${process.version}, PID ${process.pid}`);

  const hasUrl = !!(process.env.ONFLIX_SUPABASE_URL || process.env.VITE_SUPABASE_URL);
  const hasKey = !!(process.env.ONFLIX_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const keyCount = geminiKeys().length;

  console.log(`[Worker] Supabase URL configured: ${hasUrl ? "YES" : "NO (missing ONFLIX_SUPABASE_URL / VITE_SUPABASE_URL)"}`);
  console.log(`[Worker] Supabase Service Key configured: ${hasKey ? "YES" : "NO (missing ONFLIX_SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY)"}`);
  console.log(`[Worker] Gemini keys active: ${keyCount}`);

  if (!hasUrl || !hasKey) {
    console.error(`\n[Worker] Configuration Error:`);
    console.error(`Please ensure your GitHub Secrets include:`);
    if (!hasUrl) console.error(`  - VITE_SUPABASE_URL (or ONFLIX_SUPABASE_URL)`);
    if (!hasKey) console.error(`  - SUPABASE_SERVICE_ROLE_KEY (or ONFLIX_SUPABASE_SERVICE_KEY)`);
    process.exit(1);
  }

  const start = Date.now();
  try {
    const res = await runProcess(
      (msg: string) => {
        const time = new Date().toISOString().substring(11, 19);
        console.log(`[${time}] ${msg}`);
      },
      { force: isForce }
    );

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[Worker] Execution finished in ${elapsed}s.`);
    console.log(`[Worker] Summary: ${res.processed} job(s) picked, results:`, JSON.stringify(res.results, null, 2));
    process.exit(0);
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`\n[Worker] Fatal error after ${elapsed}s:`, err);
    process.exit(1);
  }
}

main();
