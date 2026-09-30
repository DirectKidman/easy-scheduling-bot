import type { APIChatInputApplicationCommandGuildInteraction, APIInteractionResponse } from "discord-api-types/v10";
import { fetchGuildNames, VOTE_MARK } from "../conflicts";
import { listOpenPollVotesForUser, type UserPollVote } from "../db/polls";
import { listUpcomingForUser } from "../db/queries";
import { defer, type Context } from "../interaction";
import { escapeMarkdown, messageLink, STATUS_META } from "../render";

/** 一度に表示する最大件数 */
const MAX_ITEMS = 20;
const MAX_POLLS = 10;

export function handleMy(
  ctx: Context,
  interaction: APIChatInputApplicationCommandGuildInteraction,
): APIInteractionResponse {
  const userId = interaction.member.user.id;
  return defer(ctx, interaction.token, "message", async () => {
    const [rows, votes] = await Promise.all([
      listUpcomingForUser(ctx.env.DB, userId, ctx.now, ["going", "maybe"]),
      listOpenPollVotesForUser(ctx.env.DB, userId, ctx.now),
    ]);
    if (rows.length === 0 && votes.length === 0) {
      return { content: "📋 参加・未定と回答した今後の予定や、回答中の日程調整はありません。" };
    }
    const shown = rows.slice(0, MAX_ITEMS);
    const polls = groupByPoll(votes).slice(0, MAX_POLLS);

    // サーバー名は保存せず、表示のたびに取得する
    const names = await fetchGuildNames(ctx.env, [...shown.map((r) => r.guild_id), ...polls.map((p) => p.guild_id)]);
    const serverLabel = (guildId: string) => `**${escapeMarkdown(names.get(guildId) ?? "（不明なサーバー）")}**`;
    const linked = (title: string, guildId: string, channelId: string, messageId: string | null) => {
      const t = escapeMarkdown(title);
      return messageId ? `[${t}](${messageLink(guildId, channelId, messageId)})` : t;
    };

    const embeds = [];
    if (shown.length > 0) {
      const lines = shown.map(
        (r) =>
          `${serverLabel(r.guild_id)}　<t:${r.start_at}:f>　${linked(r.title, r.guild_id, r.channel_id, r.message_id)}　${STATUS_META[r.status].emoji}`,
      );
      if (rows.length > shown.length) lines.push(`…ほか ${rows.length - shown.length} 件`);
      embeds.push({
        title: "📋 あなたの予定",
        description: lines.join("\n"),
        footer: { text: "✅ 参加・🤔 未定と回答した予定を表示しています" },
      });
    }
    if (polls.length > 0) {
      const lines = polls.map((p) => {
        const marks = p.votes.map((v) => `<t:${v.start_at}:f> ${VOTE_MARK[v.value]}`).join("、");
        return `${serverLabel(p.guild_id)}　${linked(p.title, p.guild_id, p.channel_id, p.message_id)}\n　${marks}`;
      });
      embeds.push({
        title: "🗳️ 回答中の日程調整",
        description: lines.join("\n"),
        footer: { text: "⭕・🔺 を付けた今後の候補日を表示しています" },
      });
    }
    return { embeds };
  });
}

interface PollGroup {
  poll_id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  votes: UserPollVote[];
}

function groupByPoll(votes: UserPollVote[]): PollGroup[] {
  const groups = new Map<number, PollGroup>();
  for (const v of votes) {
    let g = groups.get(v.poll_id);
    if (!g) {
      g = { poll_id: v.poll_id, guild_id: v.guild_id, channel_id: v.channel_id, message_id: v.message_id, title: v.title, votes: [] };
      groups.set(v.poll_id, g);
    }
    g.votes.push(v);
  }
  return [...groups.values()];
}
