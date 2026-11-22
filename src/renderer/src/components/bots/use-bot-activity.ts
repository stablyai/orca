import type { Bot } from '../../../../shared/bot-types'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotActivityRead } from '../../../../shared/bots/bot-activity-schema'
import { createBotHostRead, useBotHostRead } from './use-bot-host-read'

const NO_ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: []
}

// One read per bot for every surface that shows it (panel, header, toggle, wait cards).
const activityRead = createBotHostRead<BotActivityRead>(
  'bots.activity',
  (result: { activity: BotActivityRead }) => result.activity,
  'Failed to read bot activity:',
  BOT_WORK_KINDS
)

/** The bot's Activity as its host builds it, the same rows a phone reads; null (no bot shown) reads nothing. */
export function useBotActivity(bot: Bot | null): BotActivity {
  return useBotActivityRead(bot) ?? NO_ACTIVITY
}

/** The same read, null until it lands. */
export function useBotActivityRead(bot: Bot | null): BotActivityRead | null {
  return useBotHostRead(activityRead, bot)
}
