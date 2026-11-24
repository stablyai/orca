// A bot side chat's "x" asks its host once: it ends the chat when nothing is left, else keeps it in
// the background as a closed tab always did. The bots UI loads only when such a tab closes.
import { readBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../../shared/bot-types'
import { botOfHomeWorkspace } from '../../../../../shared/bots/bot-homes'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { chatTabShowing } from './chat-tab-showings'

type TabClose = {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}

/** The bot whose side chat this tab is, with the host's name for its showing; null for any other tab
 *  (the Home Chat, a plain chat, or a host that sends no showing). */
export function botSideChatTab(args: TabClose): { bot: Bot; showing: string } | null {
  const bot = botOfHomeWorkspace(readBots(), args.worktreeId)
  const showing = chatTabShowing(args.target, args.worktreeId, args.sessionId)
  return bot && showing && bot.chatSessionId !== args.sessionId ? { bot, showing } : null
}

/** Resolves as the plain close does: whether the host no longer lists the tab. */
export async function closeBotSideChatTab(
  args: TabClose,
  tab: { bot: Bot; showing: string },
  plainClose: () => Promise<boolean>
): Promise<boolean> {
  const ending = await import('@/components/bots/bot-chat-end')
  if (!ending.botHostEndsChats(tab.bot)) {
    return plainClose()
  }
  try {
    const result = await ending.requestBotChatEnd(tab.bot, {
      chat: args.sessionId,
      intent: 'x',
      showing: tab.showing
    })
    ending.showBotChatTabCloseResult(tab.bot, args.sessionId, result)
    return result.outcome === 'ended' || ('background' in result && result.background === true)
  } catch (error) {
    args.onError?.(error)
    return false
  }
}
