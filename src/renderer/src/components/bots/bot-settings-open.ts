import { useAppStore } from '@/store'
import { openBotHome, readBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import {
  type BotSettingsHost,
  type BotSettingsPage,
  type BotSettingsPlace as BotSettingsViewPlace,
  setBotSettingsPlace
} from './settings-view/bot-settings-place'

/** A subpage of the bot's settings, or Memory on its History; absent opens the root. */
export type BotSettingsPlace = BotSettingsPage | 'memory-history'

function viewPlace(botId: string, place: BotSettingsPlace | undefined): BotSettingsViewPlace {
  if (place === 'memory-history') {
    return { botId, page: 'memory', memoryTab: 'history' }
  }
  return { botId, page: place ?? null }
}

/** The bot in Settings › Bots, its view at `place`. */
export function openBotSettingsPage(botId: string, place?: BotSettingsPlace): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  setBotSettingsPlace('page', viewPlace(botId, place))
  openSettingsTarget({ pane: 'bots', repoId: null, sectionId: botId })
  openSettingsPage()
}

/** The bot's page with its panel's Activity tab showing its settings; false when its page can't open. */
function openBotSettingsPanel(bot: Bot, place: BotSettingsPlace | undefined): boolean {
  if (!openBotHome(bot)) {
    return false
  }
  setBotSettingsPlace('panel', viewPlace(bot.id, place))
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-activity')
  setRightSidebarOpen(true)
  return true
}

/** The host a link opens the view in: Settings while Settings shows, else the bot's panel. */
function linkHost(): BotSettingsHost {
  return useAppStore.getState().activeView === 'settings' ? 'page' : 'panel'
}

/**
 * The bot's settings at `place`, in the host the link was clicked in: Settings › Bots from Settings,
 * else the bot's panel, which switches to the bot's page first. Settings when its page can't open.
 */
export function openBotSettings(botId: string, place?: BotSettingsPlace): void {
  const bot = readBots().find((entry) => entry.id === botId)
  if (linkHost() === 'page' || !bot || !openBotSettingsPanel(bot, place)) {
    openBotSettingsPage(botId, place)
  }
}

/** The bot's page with its Connectors tab showing; false when its page can't open. */
export function openBotConnectorsTab(bot: Bot): boolean {
  if (!openBotHome(bot)) {
    return false
  }
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-connectors')
  setRightSidebarOpen(true)
  return true
}
