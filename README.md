# bitchord-torbox-addon

A source addon for [BitChord](https://github.com/kushagrasinghx/BitChord) that
serves lossless tracks from a TorBox library, as a Cloudflare Worker backed by
a D1 index.

## What it serves

Everything sits behind a secret path prefix, because `/stream` proxies a URL
that carries your TorBox API key:

```
https://<worker>.<subdomain>.workers.dev/<PATH_SECRET>/manifest.json
https://<worker>.<subdomain>.workers.dev/<PATH_SECRET>/search?q=...
https://<worker>.<subdomain>.workers.dev/<PATH_SECRET>/stream/<file-id>
```

BitChord is given `https://<worker>.<subdomain>.workers.dev/<PATH_SECRET>` as
the addon URL (Settings → Sources).

A cron runs every two minutes: it walks the library, indexes FLAC, and fills in
durations for rows the prober could reach.

## Setup

```sh
bun install

# Index database — put the id it prints into wrangler.toml.
wrangler d1 create bitchord-addon
wrangler d1 execute bitchord-addon --remote --file=schema.sql

# Secrets. PATH_SECRET is the URL prefix; pick something unguessable.
wrangler secret put TORBOX_KEY
wrangler secret put PATH_SECRET

wrangler deploy
```

Locally: `cp .dev.vars.example .dev.vars`, fill it in, then `bun run dev`.
`wrangler dev` runs the Worker against a local copy of the database.

## Tests

```sh
bun test
```

## License

MIT — see [LICENSE](LICENSE).
