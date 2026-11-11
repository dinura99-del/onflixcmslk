import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  const { checkSecret, runScan } = await import("@/lib/engine.server");
  const url = new URL(request.url);
  const token =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("secret") ||
    url.searchParams.get("token") ||
    url.searchParams.get("key");
  try {
    if (!checkSecret(token)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json({ ok: true, ...(await runScan()) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/cron/scan")({
  server: { handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) } },
});
