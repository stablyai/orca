import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { botTemplateText } from '../../../../shared/bots/bot-template-text'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { botRefKey, forEachBotHost } from '@/lib/bot-hosts'
import type { BotRosterEntry } from '../../../../shared/bot-roster'

// One list for every surface, keyed by botRefKey: each host reads each SOUL.md once per ask, however many chats show it.
let purposes: ReadonlyMap<string, string> = new Map()
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const read = (): ReadonlyMap<string, string> => purposes

/** Ask the host again; asks already on their way are shared. */
export function refreshBotPurposes(): Promise<void> {
  inFlight ??= forEachBotHost(({ target }) =>
    callRuntimeRpc<{ bots: BotRosterEntry[] }>(target, 'bots.roster', { withoutChats: true })
  )
    .then((answers) => {
      purposes = new Map(
        answers.flatMap(({ host, value }) =>
          value.bots.flatMap((bot) =>
            bot.specialty ? [[botRefKey({ hostId: host.hostId, id: bot.id }), bot.specialty]] : []
          )
        )
      )
      listeners.forEach((listener) => listener())
    })
    .catch(() => {})
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** What each bot is for (by botRefKey), from its SOUL.md, as last read; reading it is left to `refreshBotPurposes`. */
export function useKnownBotPurposes(): ReadonlyMap<string, string> {
  const t = useTranslate()
  const known = useSyncExternalStore(subscribe, read, read)
  // Why: a template's purpose is saved in English; it reads in the UI language until the owner rewrites it.
  return useMemo(
    () => new Map([...known].map(([key, purpose]) => [key, botTemplateText(purpose, t)])),
    [known, t]
  )
}

/** What each bot is for, read again on mount so an edit shows at once; empty until the host answers.
 *  `enabled` false skips the read. */
export function useBotPurposes(enabled = true): ReadonlyMap<string, string> {
  useEffect(() => {
    if (enabled) {
      void refreshBotPurposes()
    }
  }, [enabled])
  return useKnownBotPurposes()
}
