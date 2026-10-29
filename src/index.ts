import { buildMatchQuery } from "./tracks";
import type { Env } from "./types";

const MANIFEST = {
  id: "torbox",
  name: "TorBox",
  version: "1.0.0",
  resources: ["search", "stream"],
};

const STREAM_TTL_S = 240;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const prefix = `/${env.PATH_SECRET}`;
    if (!url.pathname.startsWith(prefix + "/")) return notFound();

    const path = url.pathname.slice(prefix.length);
    if (path === "/manifest.json") return json(MANIFEST);
    if (path === "/search") return search(url, env);
    if (path.startsWith("/stream/")) {
      return stream(decode(path.slice("/stream/".length)), env, ctx);
    }
    return notFound();
  },

  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;

/**
 * A minted link, cached at the edge. TorBox returns the same URL every time for
 * the same file, so the only reason to call it again is the 4-minute expiry that
 * keeps a `cdn_selection` change from being ignored for longer.
 */
async function stream(id: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) return notFound();
  if (!env.TORBOX_KEY) return json({ error: "TORBOX_KEY is not set" }, 500);

  const cache = caches.default;
  const key = new Request(`https://addon.internal/stream/${id}`);
  const hit = await cache.match(key);
  if (hit) return redirect(await hit.text());

  const api = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  api.searchParams.set("token", env.TORBOX_KEY);
  api.searchParams.set("torrent_id", m[1]);
  api.searchParams.set("file_id", m[2]);
  api.searchParams.set("redirect", "false");

  let body: { success?: boolean; data?: unknown };
  try {
    const res = await fetch(api, {
      headers: { Authorization: `Bearer ${env.TORBOX_KEY}` },
    });
    // A 5xx is TorBox having a bad minute: 502 so the app retries later.
    // Anything else that is not success is a miss, which is a 404.
    if (res.status >= 500) return json({ error: "torbox unavailable" }, 502);
    if (!res.ok) return notFound();
    body = (await res.json()) as { success?: boolean; data?: unknown };
  } catch {
    return json({ error: "torbox unavailable" }, 502);
  }

  if (body.success !== true || typeof body.data !== "string") return notFound();

  ctx.waitUntil(
    cache.put(
      key,
      new Response(body.data, {
        headers: { "Cache-Control": `public, max-age=${STREAM_TTL_S}` },
      }),
    ),
  );
  return redirect(body.data);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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
