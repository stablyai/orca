// A bot's Look around as its host decides it, read off or on: the saved setting and its schedule
// state. Null from a host too old to answer, which also can't save custom times or a zone.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { Bot } from '../../../../shared/bot-types'
import type { BotLookAround, UpNextState } from '../../../../shared/bots/bot-look-around'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { botRefKey, callBotRpc } from '@/lib/bot-hosts'
import { createBotHostUnseenCounts } from '@/lib/bot-host-per-bot-read'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { createBotHostRead, useBotHostRead } from './use-bot-host-read'

export type LookAroundStatus = { setting: BotLookAround; upNext: UpNextState }

const statusRead = createBotHostRead<LookAroundStatus>(
  'bots.lookAround.get',
  (result: LookAroundStatus) => result,
  'Failed to read Look around:',
  BOT_WORK_KINDS
)

/** The longest wait setTimeout takes. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** How soon to look again at a slot that's due, to see it start. */
const DUE_RECHECK_MS = 60_000

export function useLookAroundStatus(bot: Bot | null): LookAroundStatus | null {
  const status = useBotHostRead(statusRead, bot)
  const nextAt = status?.upNext.nextAt
  const due = status?.upNext.dueNow === true
  const hostId = bot?.hostId
  const botId = bot?.id
  // Read again once Next look's time passes, and when the window comes back, so an open page never
  // shows a time already gone by.
  useEffect(() => {
    if (hostId === undefined || botId === undefined) {
      return
    }
    const refresh = (): void => statusRead.request({ hostId, id: botId })
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    // While due, ask again each minute until it isn't: a held slot can stay due for its whole grace
    // with no other change to say so, and an unchanged answer doesn't re-run this effect.
    const wait = nextAt !== undefined ? nextAt - Date.now() + 1_000 : null
    const stopListening = (): void => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
    if (due) {
      const stop = installWindowVisibilityInterval({ run: refresh, intervalMs: DUE_RECHECK_MS })
      return () => {
        stop()
        stopListening()
      }
    }
    const timer = setTimeout(
      refresh,
      wait !== null && wait < MAX_TIMER_MS ? Math.max(wait, 1_000) : MAX_TIMER_MS
    )
    return () => {
      clearTimeout(timer)
      stopListening()
    }
  }, [hostId, botId, nextAt, due])
  return status
}

const failing = createBotHostUnseenCounts('bots.lookAround.failing', ['lookAround', 'bot'])

/** Failed looks in a row when the owner should step in (a few while on, or the ones that turned it
 *  off), else 0; for the sidebar badge and the Activity row. */
export function useLookAroundFailing(bot: Bot | null): number {
  return failing.useCount(bot)
}

/** Asks the bot's host, before an edit that needs it, whether it keeps custom times and a zone.
 *  Says why not, and saves nothing, when it can't or doesn't answer. */
export async function lookAroundHostTakesCustom(bot: Bot): Promise<boolean> {
  try {
    statusRead.request(bot)
    await callBotRpc(bot, 'bots.lookAround.get', { botId: bot.id })
    return true
  } catch (error) {
    toast.error(
      hasRuntimeRpcErrorCode(error, 'method_not_found')
        ? translate(
            'bots.lookAround.hostTooOld',
            'This bot’s computer runs an older Orca that can’t keep custom times. Update Orca there first.'
          )
        : translate(
            'bots.lookAround.hostUnreachable',
            'Couldn’t reach this bot’s computer. Nothing was saved.'
          )
    )
    return false
  }
}

/** The latest status read's error, null once a read lands. */
export function useLookAroundReadError(bot: Bot): unknown {
  const { hostId, id } = bot
  const key = botRefKey(bot)
  const subscribe = useCallback(
    (listener: () => void) => statusRead.subscribe({ hostId, id }, listener),
    [hostId, id]
  )
  const snapshot = useCallback(() => statusRead.errorSnapshot(key), [key])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function refreshLookAroundStatus(bot: Bot): void {
  statusRead.request(bot)
}
