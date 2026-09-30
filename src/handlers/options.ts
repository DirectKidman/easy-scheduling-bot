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
