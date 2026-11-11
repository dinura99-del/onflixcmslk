import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  key: z.string().max(500),
  tmdbId: z.number().int().positive(),
  mediaType: z.enum(["movie", "tv"]),
  season: z.number().int().min(0).max(500).optional(),
  episode: z.number().int().min(1).max(5000).optional(),
  review: z.enum(["fix", "keep"]).optional(),
  cachedTranslatedSrt: z.string().max(2000000).optional(),
  cachedPolishedCues: z.record(z.string(), z.string()).optional(),
});

// Streams manual-process progress as NDJSON: {log} lines, then a final {done,status}.
async function handle(request: Request) {
  const { checkSecret, runManual } = await import("@/lib/engine.server");
  let data: z.infer<typeof Body>;
  try { data = Body.parse(await request.json()); }
  catch { return Response.json({ error: "Invalid input" }, { status: 400 }); }
  if (!checkSecret(data.key)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        const r = await runManual(
          {
            tmdbId: data.tmdbId,
            mediaType: data.mediaType,
            season: data.season,
            episode: data.episode,
            review: data.review,
            cachedTranslatedSrt: data.cachedTranslatedSrt,
            cachedPolishedCues: data.cachedPolishedCues,
            onTranslated: (trSrt) => send({ trSrt }),
            onPolishedChunk: (cues) => send({ polishedChunk: cues }),
          },
          (m) => send({ log: m }),
        );
        send({ done: true, status: r.status, title: r.title, issues: r.issues });
      } catch (e) {
        send({ log: `✗ ${(e as Error).message}` });
        send({ done: true, status: "failed" });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
}

export const Route = createFileRoute("/api/public/manual/stream")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
