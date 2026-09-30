import type { APIMessage } from "discord-api-types/v10";
import { listResponses, transitionEventState, type EventRow } from "./db/queries";
import { DiscordErrorCode, discordRequest, isDiscordError } from "./discord/rest";
import type { Env } from "./env";
import { buildAnnouncement, fallbackHeader } from "./render";

export type RefreshResult = "updated" | "missing" | "skipped";

/**
 * 告知メッセージを DB の状態から再描画する。
 * 日時・場所・説明などのヘッダーは DB に持たず、既存メッセージの埋め込みから引き継ぐ。
 * メッセージが消されていた場合はイベントを message_deleted にして "missing" を返す。
 */
export async function refreshAnnouncement(env: Env, event: EventRow): Promise<RefreshResult> {
  if (!event.message_id) return "skipped";
  const path = `/channels/${event.channel_id}/messages/${event.message_id}`;
  try {
    const message = await discordRequest<APIMessage>(env, "GET", path);
    const header = message.embeds[0]?.description ?? fallbackHeader(event);
    const responses = await listResponses(env.DB, event.id);
    await discordRequest(env, "PATCH", path, { body: buildAnnouncement(event, header, responses) });
    return "updated";
  } catch (err) {
    if (isDiscordError(err, DiscordErrorCode.UnknownMessage, DiscordErrorCode.UnknownChannel)) {
      if (event.state === "scheduled") {
        await transitionEventState(env.DB, event.id, "scheduled", "message_deleted");
      }
      return "missing";
    }
    throw err;
  }
}
