import type { AvatarImageAgent } from './avatar-generation/avatar-generation-contract'
import type { BotRunChatCloseAfter } from './bots/bot-run-chat-close'

/** Settings › Bots. */
export type BotsGlobalSettings = {
  /** Bots (Settings › Bots), on unless turned off. Off hides every bot surface and skips bot runs; bot folders stay on disk. */
  botsEnabled?: boolean
  /** New Home Chat starts without asking, once the owner ticked Don't ask again. */
  skipNewHomeChatConfirm?: boolean
  /** How long this host keeps a finished run's own chat open, for bots that don't choose. */
  botRunChatsCloseAfter?: BotRunChatCloseAfter
  /** The agent the avatar Generate tab used last; it opens on that agent while it can still run. */
  avatarGenerationAgent?: AvatarImageAgent
  /** The description that made a bot's saved picture, by `host|bot|avatar`; shown as its caption. */
  generatedAvatarDescriptions?: Record<string, string>
}
