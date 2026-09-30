import {
  InteractionResponseType,
  MessageFlags,
  type APIInteractionResponse,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
} from "discord-api-types/v10";
import { discordRequest } from "./discord/rest";
import type { Env } from "./env";

export interface Context {
  env: Env;
  exec: ExecutionContext;
  /** 現在時刻（UNIX 秒） */
  now: number;
}

export type MessageBody = RESTPatchAPIWebhookWithTokenMessageJSONBody;

/** 自分にだけ見えるメッセージで返す */
export function ephemeral(content: string): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
  };
}

export function ephemeralMessage(body: MessageBody): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { allowed_mentions: { parse: [] }, ...body, flags: MessageFlags.Ephemeral } as never,
  };
}

export function editOriginal(env: Env, token: string, body: MessageBody): Promise<unknown> {
  return discordRequest(
    env,
    "PATCH",
    `/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`,
    { body: { allowed_mentions: { parse: [] }, ...body }, noAuth: true },
  );
}

/**
 * 3 秒以内に「処理中」の応答を返し、重い処理は応答後に行って元のメッセージを編集する。
 * mode: "message" は新しい（自分にだけ見える）メッセージ、"update" はボタンが付いたメッセージの更新。
 */
export function defer(
  ctx: Context,
  token: string,
  mode: "message" | "update",
  work: () => Promise<MessageBody>,
): APIInteractionResponse {
  ctx.exec.waitUntil(
    (async () => {
      let body: MessageBody;
      try {
        body = await work();
      } catch (err) {
        logError("deferred work failed", err);
        body = { content: "⚠️ エラーが発生しました。時間をおいて再度お試しください。", embeds: [], components: [] };
      }
      try {
        await editOriginal(ctx.env, token, body);
      } catch (err) {
        logError("edit original failed", err);
      }
    })(),
  );
  return mode === "message"
    ? { type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: MessageFlags.Ephemeral } }
    : { type: InteractionResponseType.DeferredMessageUpdate };
}

/** ログにはイベント内容や回答内容を出さない。エラーの種類とメッセージだけを出す。 */
export function logError(label: string, err: unknown): void {
  if (err instanceof Error) console.error(`${label}: ${err.name}: ${err.message}`);
  else console.error(`${label}: unknown error`);
}
