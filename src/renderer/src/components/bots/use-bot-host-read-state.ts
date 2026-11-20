// Whether a bot host read has landed, for the surfaces that show its loading and failure.
import { useCallback, useSyncExternalStore } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import type { BotHostRead, BotHostReadState } from './use-bot-host-read'

const NO_SUBSCRIPTION = (): (() => void) => () => {}

/** Whether the read has landed for the bot, and a retry; reads only while `useBotHostRead` keeps it open. */
export function useBotHostReadState(
  read: BotHostRead<unknown>,
  bot: Bot | null
): { state: BotHostReadState; refreshFailed: boolean; retry: () => void } {
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const key = bot ? botRefKey(bot) : null
  const subscribe = useCallback(
    (listener: () => void) =>
      botId && hostId ? read.subscribe({ hostId, id: botId }, listener) : NO_SUBSCRIPTION(),
    [read, botId, hostId]
  )
  const getState = useCallback(
    (): BotHostReadState => (key ? read.state(key) : 'loading'),
    [read, key]
  )
  const state = useSyncExternalStore(subscribe, getState, getState)
  const getRefreshFailed = useCallback(
    (): boolean => (key ? read.refreshFailed(key) : false),
    [read, key]
  )
  const refreshFailed = useSyncExternalStore(subscribe, getRefreshFailed, getRefreshFailed)
  const retry = useCallback(() => {
    if (botId && hostId) {
      read.request({ hostId, id: botId })
    }
  }, [read, botId, hostId])
  return { state, refreshFailed, retry }
}
