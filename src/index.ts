import { buildMatchQuery, extensionOf, isAudio, parseArtist, parseTitle } from "./tracks";
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

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(sync(env));
  },
} satisfies ExportedHandler<Env>;

const SYNC_PAGE = 25;

/**
 * One page of the library per tick, inserting only what is not already here.
 * A cursor rather than a full pass because the whole `mylist` is 9 MB: parsing
 * that in one invocation is over the free plan's CPU budget.
 */
async function sync(env: Env): Promise<void> {
  if (!env.TORBOX_KEY) {
    console.error("sync: TORBOX_KEY is not set");
    return;
  }

  try {
    const row = await env.DB.prepare("SELECT cursor FROM sync_state WHERE id = 1")
      .first<{ cursor: number }>();
    const cursor = row?.cursor ?? 0;

    const res = await fetch(
      `https://api.torbox.app/v1/api/torrents/mylist?limit=${SYNC_PAGE}&offset=${cursor}`,
      { headers: { Authorization: `Bearer ${env.TORBOX_KEY}` } },
    );
    if (!res.ok) {
      console.error("sync: mylist", res.status);
      return;
    }

    const body = (await res.json()) as { data?: any[] };
    const torrents = body.data ?? [];

    if (torrents.length === 0) {
      await env.DB.prepare("UPDATE sync_state SET cursor = 0 WHERE id = 1").run();
      return;
    }

    const stmts: D1PreparedStatement[] = [];
    for (const t of torrents) {
      const artist = parseArtist(String(t.name ?? ""));
      for (const f of t.files ?? []) {
        const shortName = String(f.short_name ?? "");
        if (!isAudio(shortName, f.mimetype)) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO tracks(torrent_id,file_id,title,artist,album,size,format)
             SELECT ?1,?2,?3,?4,?5,?6,?7
             WHERE NOT EXISTS (
               SELECT 1 FROM tracks WHERE torrent_id = ?1 AND file_id = ?2
             )`,
          ).bind(
            Number(t.id) || 0,
            Number(f.id) || 0,
            parseTitle(shortName),
            artist,
            String(t.name ?? ""),
            Number(f.size) || 0,
            extensionOf(shortName),
          ),
        );
      }
    }

    if (stmts.length > 0) await env.DB.batch(stmts);

    // A short page means this was the end of the account; start over.
    const next = torrents.length < SYNC_PAGE ? 0 : cursor + torrents.length;
    await env.DB.prepare("UPDATE sync_state SET cursor = ?1 WHERE id = 1").bind(next).run();
  } catch (err) {
    console.error("sync failed:", err instanceof Error ? err.message : err);
  }
}

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
