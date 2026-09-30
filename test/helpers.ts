import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ApplicationCommandType,
  ComponentType,
  InteractionType,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import { vi } from "vitest";
import worker from "../src/index";

export const GUILD_ID = "200000000000000001";
export const CHANNEL_ID = "300000000000000001";
export const ADMIN_ID = "400000000000000001";
export const MEMBER_ID = "400000000000000002";
export const OPERATOR_ROLE_ID = "500000000000000001";

export const ADMIN_PERMS = String(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.SendMessages);
export const MEMBER_PERMS = String(PermissionFlagsBits.SendMessages);

// ---- 署名付きリクエスト ----

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

let signingKey: Promise<CryptoKey> | undefined;

export async function sign(timestamp: string, body: string): Promise<string> {
  signingKey ??= crypto.subtle.importKey("pkcs8", hexToBytes(env.TEST_PRIVATE_KEY), { name: "Ed25519" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await signingKey, new TextEncoder().encode(timestamp + body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function callWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function interact(payload: object): Promise<any> {
  const body = JSON.stringify({ application_id: env.DISCORD_APPLICATION_ID, version: 1, token: "itoken", ...payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await callWorker(
    new Request("https://bot.example/", {
      method: "POST",
      body,
      headers: { "X-Signature-Ed25519": await sign(timestamp, body), "X-Signature-Timestamp": timestamp },
    }),
  );
  if (res.status !== 200) throw new Error(`worker returned ${res.status}`);
  return res.json();
}

export async function runCron(cron: string, scheduledTime = Date.now()): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron, scheduledTime }), env, ctx);
  await waitOnExecutionContext(ctx);
}

// ---- インタラクションのペイロード ----

interface Actor {
  userId?: string;
  permissions?: string;
  roles?: string[];
  guildId?: string;
}

function member({ userId = MEMBER_ID, permissions = MEMBER_PERMS, roles = [] }: Actor) {
  return { user: { id: userId, username: "u", discriminator: "0", global_name: null, avatar: null }, roles, permissions };
}

export function command(name: string, options: object[] = [], actor: Actor = {}) {
  return {
    id: "1",
    type: InteractionType.ApplicationCommand,
    guild_id: actor.guildId ?? GUILD_ID,
    channel_id: CHANNEL_ID,
    member: member(actor),
    data: { id: "1", name, type: ApplicationCommandType.ChatInput, options },
  };
}

export function modal(customId: string, values: Record<string, string>, actor: Actor = {}) {
  return {
    id: "1",
    type: InteractionType.ModalSubmit,
    guild_id: actor.guildId ?? GUILD_ID,
    channel_id: CHANNEL_ID,
    member: member(actor),
    data: {
      custom_id: customId,
      components: Object.entries(values).map(([id, value]) => ({
        type: ComponentType.ActionRow,
        components: [{ type: ComponentType.TextInput, custom_id: id, value }],
      })),
    },
  };
}

export function button(customId: string, message: object = { embeds: [] }, actor: Actor = {}) {
  return {
    id: "1",
    type: InteractionType.MessageComponent,
    guild_id: actor.guildId ?? GUILD_ID,
    channel_id: CHANNEL_ID,
    member: member(actor),
    message: { id: "m", channel_id: CHANNEL_ID, ...message },
    data: { custom_id: customId, component_type: ComponentType.Button },
  };
}

// ---- Discord REST API の偽物 ----

export interface FakeMessage {
  id: string;
  channel_id: string;
  embeds: { description?: string; title?: string; fields?: { name: string; value: string }[] }[];
  components: unknown[];
  content?: string;
}

export class FakeDiscord {
  calls: { method: string; path: string; body: any }[] = [];
  messages = new Map<string, FakeMessage>();
  guilds = new Map<string, string>([[GUILD_ID, "テストサーバー"]]);
  /** DM を閉じているユーザー */
  closedDms = new Set<string>();
  /** 投稿に失敗させるチャンネル（権限不足） */
  forbiddenChannels = new Set<string>();
  private nextId = 900000000000000000n;

  install(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/v10/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      this.calls.push({ method, path, body });
      return this.handle(method, path, body);
    });
  }

  callsTo(method: string, pattern: RegExp) {
    return this.calls.filter((c) => c.method === method && pattern.test(c.path));
  }

  followups() {
    return this.callsTo("PATCH", /^\/webhooks\/.*\/messages\/@original$/).map((c) => c.body);
  }

  private id(): string {
    return String(this.nextId++);
  }

  private handle(method: string, path: string, body: any): Response {
    const ok = (data: unknown) => Response.json(data);
    const err = (status: number, code: number) => Response.json({ code, message: "error" }, { status });
    let m: RegExpExecArray | null;

    if ((m = /^\/channels\/(\d+)\/messages$/.exec(path)) && method === "POST") {
      if (this.forbiddenChannels.has(m[1]!)) return err(403, 50013);
      const msg: FakeMessage = { id: this.id(), channel_id: m[1]!, embeds: [], components: [], ...body };
      this.messages.set(msg.id, msg);
      return ok(msg);
    }
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      const msg = this.messages.get(m[2]!);
      if (!msg || msg.channel_id !== m[1]) return err(404, 10008);
      if (method === "GET") return ok(msg);
      if (method === "PATCH") {
        Object.assign(msg, body);
        return ok(msg);
      }
    }
    if ((m = /^\/guilds\/(\d+)$/.exec(path)) && method === "GET") {
      const name = this.guilds.get(m[1]!);
      return name ? ok({ id: m[1], name }) : err(404, 10004);
    }
    if (path === "/users/@me/channels" && method === "POST") {
      return ok({ id: `dm${body.recipient_id}`, type: 1 });
    }
    if ((m = /^\/channels\/dm(\d+)\/messages$/.exec(path)) && method === "POST") {
      if (this.closedDms.has(m[1]!)) return err(403, 50007);
      return ok({ id: this.id(), channel_id: `dm${m[1]}`, ...body });
    }
    if (/^\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path) && method === "PATCH") {
      return ok({ id: this.id(), ...body });
    }
    return err(404, 0);
  }
}

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM responses"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM servers"),
  ]);
}

export async function seedServer(
  overrides: Partial<{ guild_id: string; operator_role_id: string | null; timezone: string; reminder_mode: string }> = {},
) {
  await env.DB.prepare(
    `INSERT INTO servers (guild_id, announce_channel_id, operator_role_id, timezone, reminder_mode)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(
      overrides.guild_id ?? GUILD_ID,
      CHANNEL_ID,
      overrides.operator_role_id ?? null,
      overrides.timezone ?? "Asia/Tokyo",
      overrides.reminder_mode ?? "channel",
    )
    .run();
}

export async function seedEvent(opts: {
  startAt: number;
  title?: string;
  messageId?: string;
  guildId?: string;
  createdAt?: number;
}) {
  const row = await env.DB.prepare(
    `INSERT INTO events (guild_id, channel_id, message_id, title, start_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
  )
    .bind(
      opts.guildId ?? GUILD_ID,
      CHANNEL_ID,
      opts.messageId ?? null,
      opts.title ?? "読書会",
      opts.startAt,
      opts.createdAt ?? opts.startAt - 7 * 86400,
    )
    .first<{ id: number }>();
  return row!.id;
}

/** 偽の Discord に告知メッセージを置き、その ID を返す */
export function seedMessage(discord: FakeDiscord, description = "日時　<t:1:F>\n主催　<@1>"): string {
  const id = String(800000000000000000n + BigInt(discord.messages.size));
  discord.messages.set(id, { id, channel_id: CHANNEL_ID, embeds: [{ title: "📅 読書会", description }], components: [] });
  return id;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
