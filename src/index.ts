import { buildMatchQuery } from "./tracks";
import type { Env } from "./types";

const MANIFEST = {
  id: "torbox",
  name: "TorBox",
  version: "1.0.0",
  resources: ["search", "stream"],
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const prefix = `/${env.PATH_SECRET}`;
    if (!url.pathname.startsWith(prefix + "/")) return notFound();

    const path = url.pathname.slice(prefix.length);
    if (path === "/manifest.json") return json(MANIFEST);
    if (path === "/search") return search(url, env);
    return notFound();
  },

  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;

async function search(url: URL, env: Env): Promise<Response> {
  const match = buildMatchQuery(url.searchParams.get("q") ?? "");
  if (!match) return json({ tracks: [] });

  try {
    const { results } = await env.DB.prepare(
      `SELECT t.torrent_id, t.file_id, t.title, t.artist, t.album, t.format
         FROM tracks_fts f JOIN tracks t ON t.id = f.rowid
        WHERE tracks_fts MATCH ?1
        ORDER BY f.rank
        LIMIT 10`,
    )
      .bind(match)
      .all<Record<string, unknown>>();

    return json({
      tracks: (results ?? []).map((r) => ({
        id: `${r.torrent_id}:${r.file_id}`,
        title: r.title,
        artist: r.artist,
        album: r.album ?? "",
        format: r.format,
      })),
    });
  } catch (err) {
    console.error("search failed:", err instanceof Error ? err.message : err);
    return json({ error: "search failed" }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}
