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
    if (path === "/manifest.json") return Response.json(MANIFEST);
    return notFound();
  },

  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;

function notFound(): Response {
  return new Response("not found", { status: 404 });
}
