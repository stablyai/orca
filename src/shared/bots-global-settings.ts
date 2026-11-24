import type { AvatarImageAgent } from './avatar-generation/avatar-generation-contract'

export type HighlightsReplyBackground = 'blue' | 'teal' | 'neutral'

export function resolveHighlightsReplyBackground(value: unknown): HighlightsReplyBackground {
  return value === 'teal' || value === 'neutral' ? value : 'blue'
}

/** Bot preferences. */
export type BotsGlobalSettings = {
  /** Bots (Settings › Bots), on unless turned off. Off hides every bot surface and skips bot runs; bot folders stay on disk. */
  botsEnabled?: boolean
  highlightsReplyBackground?: HighlightsReplyBackground
  /** New Home Chat starts without asking, once the owner ticked Don't ask again. */
  skipNewHomeChatConfirm?: boolean
  /** The agent the avatar Generate tab used last; it opens on that agent while it can still run. */
  avatarGenerationAgent?: AvatarImageAgent
  /** The description that made a bot's saved picture, by `host|bot|avatar`; shown as its caption. */
  generatedAvatarDescriptions?: Record<string, string>
}
