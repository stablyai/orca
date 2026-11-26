import { useCallback } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotActivityRead } from '../../../../shared/bots/bot-activity-schema'
import type { BotReadAuthority } from './bot-read-authority'
import { createBotHostRead, useBotHostRead, type BotReadSettled } from './use-bot-host-read'

export const NO_ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: []
}

/** The Activity a read returned, with the host incarnation that returned it. */
export type BotActivityWithAuthority = { activity: BotActivityRead; authority: BotReadAuthority }

// One read per bot for every surface that shows it (panel, header, toggle, wait cards).
const activityRead = createBotHostRead<BotActivityWithAuthority>(
  'bots.activity',
  (result: { activity: BotActivityRead }, authority) => ({ activity: result.activity, authority }),
  'Failed to read bot activity:',
  BOT_WORK_KINDS
)

// Stable, so a new incarnation answering the same Activity renders none of its plain readers.
const selectActivity = (read: BotActivityWithAuthority): BotActivityRead => read.activity

/** The bot's Activity as its host builds it, the same rows a phone reads; null (no bot shown) reads nothing. */
export function useBotActivity(bot: Bot | null): BotActivity {
  return useBotActivityRead(bot) ?? NO_ACTIVITY
}

/** The same read, null until it lands. */
export function useBotActivityRead(bot: Bot | null): BotActivityRead | null {
  return useBotHostRead(activityRead, bot, selectActivity)
}

/** The read with its authority, for a surface that acts on what it shows (Delete). */
export function useBotActivityAuthorityRead(bot: Bot | null): {
  read: BotActivityWithAuthority | null
  /** Latest raw publication, including reads that React has yet to commit. */
  currentRead: () => BotActivityWithAuthority | null
  /** Ask the shared read again. */
  refresh: () => void
  /** A read started after this ask, or uncertain (`BotHostRead.requestSettled`). */
  refreshSettled: (
    deadline: number,
    canStart?: () => boolean
  ) => Promise<BotReadSettled<BotActivityWithAuthority>>
} {
  const read = useBotHostRead(activityRead, bot)
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const key = bot ? botRefKey(bot) : null
  const currentRead = useCallback(() => (key === null ? null : activityRead.snapshot(key)), [key])
  const refresh = useCallback(() => {
    if (botId && hostId) {
      activityRead.request({ hostId, id: botId })
    }
  }, [botId, hostId])
  const refreshSettled = useCallback(
    (
      deadline: number,
      canStart?: () => boolean
    ): Promise<BotReadSettled<BotActivityWithAuthority>> =>
      botId && hostId
        ? activityRead.requestSettled({ hostId, id: botId }, deadline, canStart)
        : Promise.resolve({ ok: false }),
    [botId, hostId]
  )
  return { read, currentRead, refresh, refreshSettled }
}
