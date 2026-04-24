/**
 * Cloudflare Worker: anonymous "like" -> Discord (or swap the fetch for email/Slack).
 *
 * Wrangler: wrangler.toml name + main = this file (use module syntax export default).
 * Secrets (do NOT commit): DISCORD_WEBHOOK, optional LIKE_SECRET, optional ALLOWED_ORIGIN
 *   (e.g. https://jacobrozell.github.io). If unset, CORS allows *.
 *
 * Deploy: npm create cloudflare@latest then paste handler, set vars in dashboard.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allow = (env.ALLOWED_ORIGIN || "").trim();
    const allowOrigin =
      !allow || allow === "*"
        ? "*"
        : origin === allow
          ? origin
          : "null";

    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Like-Secret",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: cors });
    }

    if (env.LIKE_SECRET) {
      const h = request.headers.get("X-Like-Secret") || "";
      if (h !== env.LIKE_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: cors });
      }
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return new Response("invalid json", { status: 400, headers: cors });
    }

    const title =
      typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title) {
      return new Response("missing title", { status: 400, headers: cors });
    }

    const hook = env.DISCORD_WEBHOOK || "";
    if (!hook) {
      return new Response("DISCORD_WEBHOOK not set", { status: 503, headers: cors });
    }

    const safe = title.replace(/@/g, "").replace(/```/g, "");
    const line = "Someone liked: **" + safe + "**";

    const dr = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: line }),
    });

    if (!dr.ok) {
      return new Response("notify failed", { status: 502, headers: cors });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
