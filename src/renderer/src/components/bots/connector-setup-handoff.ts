// A server bot's Slack or Linear setup started in Settings moves to the bot's own Connectors tab
// first: its sign-in page opens in the bot's workspace, which leaves Settings and would take a
// dialog open there with it. The tab's Add connector takes the setup up when it mounts.
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../shared/bot-types'
import type { BotConnectorId } from './AddConnectorDialog'
import { openBotConnectorsTab } from './bot-settings-open'

const pending = new Map<string, BotConnectorId>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True when the setup moved to the bot's page, which then starts it; false to start it here. */
export function handOffConnectorSetup(bot: Bot, connector: BotConnectorId): boolean {
  if (
    bot.hostId === LOCAL_EXECUTION_HOST_ID ||
    (connector !== 'slack' && connector !== 'linear') ||
    useAppStore.getState().activeView !== 'settings' ||
    !openBotConnectorsTab(bot)
  ) {
    return false
  }
  pending.set(botRefKey(bot), connector)
  listeners.forEach((listener) => listener())
  return true
}

/** The setup handed to this bot's page, if one waits; reading it takes it. */
export function takeConnectorSetup(bot: BotRef): BotConnectorId | null {
  const key = botRefKey(bot)
  const connector = pending.get(key) ?? null
  pending.delete(key)
  return connector
}

/** Whether a setup waits for this bot's page. */
export function useConnectorSetupWaiting(bot: BotRef): boolean {
  const key = botRefKey(bot)
  const read = (): boolean => pending.has(key)
  return useSyncExternalStore(subscribe, read, read)
}
