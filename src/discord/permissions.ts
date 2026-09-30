import { PermissionFlagsBits, type APIInteractionGuildMember } from "discord-api-types/v10";
import type { ServerRow } from "../db/queries";

export function hasPermission(permissions: string | undefined, flag: bigint): boolean {
  if (!permissions) return false;
  const bits = BigInt(permissions);
  return (bits & PermissionFlagsBits.Administrator) !== 0n || (bits & flag) !== 0n;
}

/** サーバー管理権限（/setup を実行できる） */
export function isManager(member: APIInteractionGuildMember | undefined): boolean {
  return hasPermission(member?.permissions, PermissionFlagsBits.ManageGuild);
}

/** 運営者（サーバー管理権限、または /setup で指定した運営ロールを持つ） */
export function isOperator(member: APIInteractionGuildMember | undefined, server: ServerRow): boolean {
  if (!member) return false;
  if (isManager(member)) return true;
  return server.operator_role_id !== null && member.roles.includes(server.operator_role_id);
}
