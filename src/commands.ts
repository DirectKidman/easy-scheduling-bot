import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";

// サーバーインストール型・サーバー内のみで使うコマンド
const guildOnly = {
  type: ApplicationCommandType.ChatInput as const,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
};

/** スラッシュコマンドの定義。変更したら `npm run register` で再登録する。 */
export const COMMANDS: RESTPutAPIApplicationCommandsJSONBody = [
  {
    ...guildOnly,
    name: "setup",
    description: "告知チャンネル・運営ロール・タイムゾーンを設定します（サーバー管理権限が必要）",
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        type: ApplicationCommandOptionType.Channel,
        name: "channel",
        description: "イベントを告知するチャンネル",
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Role,
        name: "operator_role",
        description: "イベントを作成・中止できる運営ロール（省略時はサーバー管理権限を持つ人のみ）",
        required: false,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: "timezone",
        description: "日時の入力に使うタイムゾーン（例: Asia/Tokyo。省略時は現在の設定、初回は Asia/Tokyo）",
        required: false,
        max_length: 64,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: "reminder",
        description: "リマインドの送り方（省略時は現在の設定、初回はチャンネル）",
        required: false,
        choices: [
          { name: "告知チャンネルでメンション", value: "channel" },
          { name: "DM（届かない人は告知チャンネルでメンション）", value: "dm" },
        ],
      },
    ],
  },
  {
    ...guildOnly,
    name: "event",
    description: "イベントを作成して告知します（運営者のみ）",
  },
  {
    ...guildOnly,
    name: "my",
    description: "参加・未定と回答した今後の予定を、サーバーをまたいで表示します",
  },
  {
    ...guildOnly,
    name: "forget",
    description: "自分の回答を削除します（過去分だけ／すべて）",
  },
];
