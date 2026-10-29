import { buildMatchQuery, extensionOf, flacSeconds, isFlac, parseArtist, parseTitle, publicDuration } from "./tracks";
import type { Env } from "./types";

const MANIFEST = {
  id: "torbox",
  name: "TorBox",
  version: "1.1.0",
  resources: ["search", "stream"],
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const STREAM_TTL_S = 240;
const SYNC_PAGE = 25;
const WALK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fail closed. An empty prefix would make "/" the gate and leave /stream
    // answering anyone, and /stream hands out the account's API key.
    if (!env.PATH_SECRET) return json({ error: "PATH_SECRET is not set" }, 500);

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
    ctx.waitUntil(
      (async () => {
        await sync(env);
        await fillDurations(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

/** Two subrequests per row, against a 50-per-invocation ceiling. */
const FILL_PER_TICK = 20;

/**
 * Fills `duration` for rows the indexer inserted without one.
 *
 * A row the prober cannot reach is marked -1 rather than left null: null means
 * "not asked yet", and leaving it null would spend this tick's whole budget on
 * the same unreachable files forever.
 */
async function fillDurations(env: Env): Promise<void> {
  if (!env.TORBOX_KEY) return;

  const { results } = await env.DB.prepare(
    "SELECT id, torrent_id, file_id FROM tracks WHERE duration IS NULL LIMIT ?1",
  )
    .bind(FILL_PER_TICK)
    .all<{ id: number; torrent_id: number; file_id: number }>();
  if (!results || results.length === 0) return;

  const updates: D1PreparedStatement[] = [];
  for (const row of results) {
    let seconds: number | null = null;
    try {
      seconds = await probeDuration(env, row.torrent_id, row.file_id);
    } catch (err) {
      console.error("duration probe failed:", err instanceof Error ? err.message : err);
    }
    updates.push(
      env.DB.prepare("UPDATE tracks SET duration = ?1 WHERE id = ?2").bind(seconds ?? -1, row.id),
    );
  }

  try {
    await env.DB.batch(updates);
  } catch (err) {
    console.error("duration write failed:", err instanceof Error ? err.message : err);
  }
}

/** Seconds of audio in one file, or null when it cannot be read. */
async function probeDuration(env: Env, torrentId: number, fileId: number): Promise<number | null> {
  const api = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  api.searchParams.set("token", env.TORBOX_KEY);
  api.searchParams.set("torrent_id", String(torrentId));
  api.searchParams.set("file_id", String(fileId));
  api.searchParams.set("redirect", "false");

  const res = await fetch(api, { headers: { Authorization: `Bearer ${env.TORBOX_KEY}` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { success?: boolean; data?: unknown };
  if (body.success !== true || typeof body.data !== "string") return null;

  const head = await fetch(body.data, {
    headers: { Authorization: `Bearer ${env.TORBOX_KEY}`, Range: "bytes=0-8191" },
  });
  if (!head.ok) return null;
  return flacSeconds(new Uint8Array(await head.arrayBuffer()));
}

async function search(url: URL, env: Env): Promise<Response> {
  const match = buildMatchQuery(url.searchParams.get("q") ?? "");
  if (!match) return json({ tracks: [] });

  try {
    const { results } = await env.DB.prepare(
      `SELECT t.torrent_id, t.file_id, t.title, t.artist, t.album, t.format, t.duration
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
        duration: publicDuration(r.duration as number | null),
      })),
    });
  } catch (err) {
    console.error("search failed:", err instanceof Error ? err.message : err);
    return json({ error: "search failed" }, 500);
  }
}

/**
 * The stream answer, as JSON — not a redirect.
 *
 * `AddonClient.body()` parses a 2xx as JSON and only special-cases 404, 429 and
 * 5xx; OkHttp follows redirects, so a 302 would be chased to the CDN and the
 * whole audio file read as a String before the decode failed. The URL is for
 * the *player* to fetch, never for this client.
 *
 * The answer is cached, not just the URL: a warm hit then costs one cache read
 * and no D1 row and no TorBox call.
 *
 * The TTL bounds staleness for a `cdn_selection` change, not validity — the
 * links live for hours. Worst case is this 240 s plus the app's own 5-minute
 * reuse of a returned URL, so ~9 minutes, not 4.
 */
async function stream(id: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) return notFound();
  if (!env.TORBOX_KEY) return json({ error: "TORBOX_KEY is not set" }, 500);

  const cache = caches.default;
  const key = new Request(`https://addon.internal/stream/${id}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: JSON_HEADERS });

  const api = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  api.searchParams.set("token", env.TORBOX_KEY);
  api.searchParams.set("torrent_id", m[1]);
  api.searchParams.set("file_id", m[2]);
  api.searchParams.set("redirect", "false");

  let body: { success?: boolean; data?: unknown };
  try {
    const res = await fetch(api, {
      headers: { Authorization: `Bearer ${env.TORBOX_KEY}` },
      // If TorBox ignores `redirect=false`, a 3xx must not be chased: the body
      // would be the audio file itself. A 3xx falls through to 502 below.
      redirect: "manual",
    });
    if (res.status === 404) return notFound();
    if (!res.ok) return json({ error: "torbox unavailable" }, 502);
    body = (await res.json()) as { success?: boolean; data?: unknown };
  } catch {
    return json({ error: "torbox unavailable" }, 502);
  }

  if (body?.success !== true || typeof body?.data !== "string") return notFound();

  const row = await env.DB.prepare(
    "SELECT format FROM tracks WHERE torrent_id = ?1 AND file_id = ?2",
  )
    .bind(m[1], m[2])
    .first<{ format: string }>();

  const payload = JSON.stringify({ url: body.data, format: row?.format ?? "" });

  ctx.waitUntil(
    cache.put(
      key,
      new Response(payload, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${STREAM_TTL_S}`,
        },
      }),
    ),
  );
  return new Response(payload, { headers: JSON_HEADERS });
}

/**
 * One page of the library per tick, inserting only what is not already here.
 * A cursor rather than a full pass because the whole `mylist` is 9 MB: parsing
 * that in one invocation is over the free plan's CPU budget.
 *
 * When the walk completes, the next one is not due for `WALK_INTERVAL_MS`.
 * Without that gate every tick re-reads an unchanged page forever, which is
 * millions of D1 rows a day bought for nothing.
 */
async function sync(env: Env): Promise<void> {
  if (!env.TORBOX_KEY) {
    console.error("sync: TORBOX_KEY is not set");
    return;
  }

  try {
    const row = await env.DB.prepare("SELECT cursor, next_walk_at FROM sync_state WHERE id = 1")
      .first<{ cursor: number; next_walk_at: number }>();
    const cursor = row?.cursor ?? 0;
    if (cursor === 0 && Date.now() < (row?.next_walk_at ?? 0)) return;

    const res = await fetch(
      `https://api.torbox.app/v1/api/torrents/mylist?limit=${SYNC_PAGE}&offset=${cursor}`,
      { headers: { Authorization: `Bearer ${env.TORBOX_KEY}` } },
    );
    if (!res.ok) {
      console.error("sync: mylist", res.status);
      return;
    }

    const body = (await res.json()) as { success?: boolean; data?: unknown };
    // A 200 with success:false is not the end of the library; treating it as
    // one would reset the walk and re-read everything.
    if (body.success !== true || !Array.isArray(body.data)) {
      console.error("sync: unexpected envelope");
      return;
    }

    const torrents = body.data as any[];
    if (torrents.length === 0) {
      await finishWalk(env);
      return;
    }

    const stmts: D1PreparedStatement[] = [];
    for (const t of torrents) {
      const artist = parseArtist(String(t.name ?? ""));
      for (const f of t.files ?? []) {
        const shortName = String(f.short_name ?? "");
        if (!isFlac(shortName)) continue;
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

    if (torrents.length < SYNC_PAGE) {
      await finishWalk(env);
      return;
    }
    await env.DB.prepare("UPDATE sync_state SET cursor = ?1 WHERE id = 1")
      .bind(cursor + torrents.length)
      .run();
  } catch (err) {
    console.error("sync failed:", err instanceof Error ? err.message : err);
  }
}

/** Cursor back to the start, and the next walk not before the interval. */
async function finishWalk(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE sync_state SET cursor = 0, next_walk_at = ?1 WHERE id = 1")
    .bind(Date.now() + WALK_INTERVAL_MS)
    .run();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
