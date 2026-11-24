// Where a bot's settings view stands in each of its two hosts: the bot's right panel and Settings › Bots.
import { useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'

/** One drill-in of the view; the root has none. */
export type BotSettingsPage =
  | 'agent'
  | 'permissions'
  | 'computer'
  | 'look-around'
  | 'tidy-up'
  | 'soul'
  | 'memory'
  | 'connectors'
  | 'who-can-ask'
  | 'tools'
  | 'skills'
  | 'sharing'

export type BotSettingsHost = 'panel' | 'page'

/** The bot the host shows; `page` null is the root. `memoryTab` opens Memory on its History. */
export type BotSettingsPlace = {
  botId: string
  page: BotSettingsPage | null
  memoryTab?: 'history'
}

let places: Record<BotSettingsHost, BotSettingsPlace | null> = { panel: null, page: null }
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Shows `place` in `host`; null closes the panel's view, or returns Settings to the Bots list. */
export function setBotSettingsPlace(host: BotSettingsHost, place: BotSettingsPlace | null): void {
  places = { ...places, [host]: place }
  listeners.forEach((listener) => listener())
}

export function readBotSettingsPlace(host: BotSettingsHost): BotSettingsPlace | null {
  return places[host]
}

/** The place `host` shows for this bot; null when it shows another bot or none. */
export function useBotSettingsPlace(host: BotSettingsHost, botId: string): BotSettingsPlace | null {
  const place = useSyncExternalStore(subscribe, () => places[host])
  return place?.botId === botId ? place : null
}

export function botSettingsPageTitle(page: BotSettingsPage): string {
  switch (page) {
    case 'agent':
      return translate('bots.settingsView.agent', 'Agent and model')
    case 'permissions':
      return translate('settings.bots.permissions', 'Permissions')
    case 'computer':
      return translate('bots.settingsView.computer', 'Computer')
    case 'look-around':
      return translate('settings.bots.lookAround.title', 'Look around')
    case 'tidy-up':
      return translate('settings.bots.tidyUp.title', 'Memory upkeep')
    case 'soul':
      return translate('settings.bots.soul', 'Soul')
    case 'memory':
      return translate('settings.bots.memory', 'Memory')
    case 'connectors':
      return translate('settings.bots.connectors', 'Connectors')
    case 'who-can-ask':
      return translate('bots.settingsView.whoCanAsk', 'Who can ask')
    case 'tools':
      return translate('settings.bots.tools.title', 'Tools')
    case 'skills':
      return translate('settings.bots.skills.title', 'Skills')
    case 'sharing':
      return translate('bots.settingsView.sharing', 'Sharing')
  }
}
