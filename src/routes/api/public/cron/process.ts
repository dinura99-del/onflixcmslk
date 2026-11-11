import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  const { checkSecret, runProcess } = await import("@/lib/engine.server");
  const url = new URL(request.url);
  const token =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("secret") ||
    url.searchParams.get("token") ||
    url.searchParams.get("key");
  const force =
    url.searchParams.get("force") === "1" ||
    url.searchParams.get("force") === "true";
  try {
    if (!checkSecret(token)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json({ ok: true, ...(await runProcess(() => {}, { force })) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/cron/process")({
  server: { handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) } },
});
