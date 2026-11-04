import {
  ComponentType,
  type APIApplicationCommandInteractionDataOption,
  type APIModalSubmitInteraction,
} from "discord-api-types/v10";

export function getOption<T extends string | number | boolean>(
  options: APIApplicationCommandInteractionDataOption[] | undefined,
  name: string,
): T | undefined {
  const opt = options?.find((o) => o.name === name);
  return opt && "value" in opt ? (opt.value as T) : undefined;
}

/** モーダルの入力値を custom_id で取り出す（ActionRow 形式と Label 形式の両方に対応） */
export function getModalValue(interaction: APIModalSubmitInteraction, customId: string): string | undefined {
  const stack: unknown[] = [...interaction.data.components];
  while (stack.length > 0) {
    const c = stack.pop() as {
      type?: number;
      custom_id?: string;
      value?: string;
      components?: unknown[];
      component?: unknown;
    };
    if (!c) continue;
    if (c.type === ComponentType.TextInput && c.custom_id === customId) return c.value;
    if (c.components) stack.push(...c.components);
    if (c.component) stack.push(c.component);
  }
  return undefined;
}

/** インタラクションが実行されたチャンネル（スレッドならスレッド）の ID */
export function interactionChannelId(interaction: { channel?: { id: string }; channel_id?: string }): string | undefined {
  return interaction.channel?.id ?? interaction.channel_id;
}

/** 告知を投稿できなかったときの案内（秘匿チャンネルに bot が入っていない場合が多い） */
export function cannotPostMessage(channelId: string): string {
  return (
    `⚠️ <#${channelId}> に投稿できませんでした。\n` +
    "秘匿チャンネルなど、bot が入っていないチャンネルでは、チャンネルの設定 →「権限」で bot（または bot のロール）を追加し、" +
    "「チャンネルを見る」「メッセージを送信」「埋め込みリンク」「メッセージ履歴を読む」を許可してください。"
  );
}
