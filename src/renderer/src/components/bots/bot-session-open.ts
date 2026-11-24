import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { cancelPendingBotThreadOpen } from '@/lib/agent-session/open/bot-thread-open-lifecycle'
import { targetBotChatLatest } from '@/lib/agent-session/open/bot-link-item-target'
import { callBotRpc } from '@/lib/bot-hosts'
import { selectFocusedChatTab } from '@/lib/focused-chat-workers'
import { useAppStore } from '@/store'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

function activate(bot: Bot, sessionId: string): Promise<boolean> {
  return activateAiVaultStructuredSession({
    structuredSession: { sessionId, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) }
  })
}

/** Opening a chat without a tab reveals it, which marks its thread seen; activating its open tab here
 *  doesn't, so this says so. An older host has no such method and keeps the thread new. */
async function markSeen(bot: Bot, sessionIds: string[]): Promise<void> {
  if (sessionIds.length > 0) {
    await callBotRpc(bot, 'bots.chats.seen', { sessionIds }).catch(() => undefined)
  }
}

/** The chat's tab when it is the one on screen, where activating it again would change nothing. */
function shownChatTab(bot: Bot, sessionId: string): { id: string } | null {
  const state = useAppStore.getState()
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  if (state.activeView !== 'terminal' || state.activeWorktreeId !== workspaceId) {
    return null
  }
  const tab = selectFocusedChatTab(state, workspaceId)
  return tab?.entityId === sessionId ? tab : null
}

/** Opens one of the bot's chats as a focused tab; a thread's or a run's gets its tab here. The chat
 *  already on screen goes to its newest output, its composer focused with the usual glow. */
export function openBotSession(bot: Bot, sessionId: string): void {
  const shown = shownChatTab(bot, sessionId)
  if (shown) {
    cancelPendingBotThreadOpen()
    targetBotChatLatest(sessionId)
    requestNativeChatComposerFocus(shown.id, { revealDraft: true })
    return
  }
  void activate(bot, sessionId).then((opened) => (opened ? markSeen(bot, [sessionId]) : undefined))
}
