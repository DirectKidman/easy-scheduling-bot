import type { APIInteraction } from "discord-api-types/v10";
import type { Env } from "./env";
import { ephemeral, logError, type Context } from "./interaction";
import { runScheduled } from "./jobs/scheduled";
import { routeInteraction } from "./router";
import { verifyDiscordRequest } from "./verify";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env, exec): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("easy-scheduling-bot is running");
    }
    if (request.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/interactions")) {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.text();
    const valid = await verifyDiscordRequest(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      body,
    );
    if (!valid) return new Response("Bad request signature", { status: 401 });

    let interaction: APIInteraction;
    try {
      interaction = JSON.parse(body) as APIInteraction;
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const ctx: Context = { env, exec, now: Math.floor(Date.now() / 1000) };
    try {
      return json(await routeInteraction(ctx, interaction));
    } catch (err) {
      logError("interaction failed", err);
      return json(ephemeral("⚠️ エラーが発生しました。時間をおいて再度お試しください。"));
    }
  },

  async scheduled(controller, env, exec): Promise<void> {
    exec.waitUntil(runScheduled(controller.cron, env, Math.floor(controller.scheduledTime / 1000)));
  },
} satisfies ExportedHandler<Env>;
