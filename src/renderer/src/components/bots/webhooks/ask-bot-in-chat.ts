import { openBotHomeTab } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'

/** Leaves Settings for the bot's Chat with `draft` typed, unsent: hooks are made and changed there. */
export function askBotInChat(bot: Bot, draft: string): void {
  const { activeView, closeSettingsPage } = useAppStore.getState()
  if (activeView === 'settings') {
    closeSettingsPage()
  }
  void openBotHomeTab(bot, { draft })
}
