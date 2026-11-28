import type { AvatarImageAgent } from './avatar-generation/avatar-generation-contract'

/** Settings › Bots. */
export type BotsGlobalSettings = {
  /** Bots (Settings › Bots), on unless turned off. Off hides every bot surface and skips bot runs; bot folders stay on disk. */
  botsEnabled?: boolean
  /** Local desktop opt-in (Settings › Bots), off by default: lets this computer's `orca bot create` create bots directly without a card. Never writable over RPC. */
  allowCliBotCreate?: boolean
  /** New Home Chat starts without asking, once the owner ticked Don't ask again. */
  skipNewHomeChatConfirm?: boolean
  /** The agent the avatar Generate tab used last; it opens on that agent while it can still run. */
  avatarGenerationAgent?: AvatarImageAgent
  /** The description that made a bot's saved picture, by `host|bot|avatar`; shown as its caption. */
  generatedAvatarDescriptions?: Record<string, string>
}
