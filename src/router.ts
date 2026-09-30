import {
  ApplicationCommandType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  type APIChatInputApplicationCommandGuildInteraction,
  type APIInteraction,
  type APIInteractionResponse,
  type APIMessageComponentGuildInteraction,
  type APIModalSubmitGuildInteraction,
} from "discord-api-types/v10";
import { handleButton } from "./handlers/buttons";
import { EVENT_MODAL_ID, handleEventCommand, handleEventModal } from "./handlers/event";
import { FORGET_PREFIX, handleForgetButton, handleForgetCommand } from "./handlers/forget";
import { handleMy } from "./handlers/my";
import { handleSetup } from "./handlers/setup";
import { ephemeral, type Context } from "./interaction";

export async function routeInteraction(ctx: Context, interaction: APIInteraction): Promise<APIInteractionResponse> {
  if (interaction.type === InteractionType.Ping) return { type: InteractionResponseType.Pong };

  // サーバーインストール型の bot なので、サーバー内のインタラクションだけを扱う
  if (!("guild_id" in interaction) || !interaction.guild_id || !interaction.member) {
    return ephemeral("このコマンドはサーバー内のチャンネルで実行してください。");
  }

  switch (interaction.type) {
    case InteractionType.ApplicationCommand: {
      if (interaction.data.type !== ApplicationCommandType.ChatInput) break;
      const cmd = interaction as APIChatInputApplicationCommandGuildInteraction;
      switch (cmd.data.name) {
        case "setup":
          return handleSetup(ctx, cmd);
        case "event":
          return handleEventCommand(ctx, cmd);
        case "my":
          return handleMy(ctx, cmd);
        case "forget":
          return handleForgetCommand(ctx, cmd);
      }
      break;
    }
    case InteractionType.MessageComponent:
      if (interaction.data.component_type === ComponentType.Button) {
        const component = interaction as APIMessageComponentGuildInteraction;
        if (component.data.custom_id.startsWith(FORGET_PREFIX)) return handleForgetButton(ctx, component);
        return handleButton(ctx, component);
      }
      break;
    case InteractionType.ModalSubmit:
      if (interaction.data.custom_id === EVENT_MODAL_ID) {
        return handleEventModal(ctx, interaction as APIModalSubmitGuildInteraction);
      }
      break;
  }
  return ephemeral("不明な操作です。");
}
