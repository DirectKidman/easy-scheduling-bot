import type { Env } from "../env";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/DirectKidman/easy-scheduling-bot, 0.1.0)";

/** Discord REST API のエラー。ログにはパスとコードだけを出す（本文は出さない）。 */
export class DiscordApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: number | undefined,
  ) {
    super(`Discord API ${method} ${path} failed: ${status}${code !== undefined ? ` (code ${code})` : ""}`);
    this.name = "DiscordApiError";
  }
}

/** よく使う JSON エラーコード。https://discord.com/developers/docs/topics/opcodes-and-status-codes#json */
export const DiscordErrorCode = {
  UnknownChannel: 10003,
  UnknownGuild: 10004,
  UnknownMessage: 10008,
  MissingAccess: 50001,
  CannotSendMessagesToThisUser: 50007,
  MissingPermissions: 50013,
} as const;

interface RequestOptions {
  body?: unknown;
  /** インタラクションの webhook など、bot トークンを付けない呼び出し */
  noAuth?: boolean;
}

export async function discordRequest<T = unknown>(
  env: Env,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (!options.noAuth) headers.Authorization = `Bot ${env.DISCORD_BOT_TOKEN}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  };

  let res = await fetch(API_BASE + path, init);
  if (res.status === 429) {
    // 短い待ちなら 1 回だけ再試行する。長い場合は呼び出し側に失敗として返す。
    const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const wait = data.retry_after ?? 1;
    if (wait <= 5) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await fetch(API_BASE + path, init);
    }
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { code?: number };
    throw new DiscordApiError(method, path.replace(/\/webhooks\/\d+\/[^/]+/, "/webhooks/:id/:token"), res.status, data.code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function isDiscordError(err: unknown, ...codes: number[]): err is DiscordApiError {
  return err instanceof DiscordApiError && err.code !== undefined && codes.includes(err.code);
}
