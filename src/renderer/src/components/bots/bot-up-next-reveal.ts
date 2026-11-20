// The bot row's Up next count: opens the bot's Activity panel at Up next, which flashes as Start's composer does.
import { glowNativeChatComposer } from '@/components/native-chat/native-chat-composer-glow'
import { useAppStore } from '@/store'

export function botUpNextGlowScope(botId: string): string {
  return `bot-up-next:${botId}`
}

/** Call once the bot's page is open: the panel it reveals is the open bot's. */
export function revealBotUpNext(botId: string): void {
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-activity')
  setRightSidebarOpen(true)
  glowNativeChatComposer(botUpNextGlowScope(botId))
}
