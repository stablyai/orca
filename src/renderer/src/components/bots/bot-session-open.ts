import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { targetBotChatLatest } from '@/lib/agent-session/open/bot-link-item-target'
import { callBotRpc } from '@/lib/bot-hosts'
import { selectFocusedChatTab } from '@/lib/focused-chat-workers'
import { useAppStore } from '@/store'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { isLocalExecutionHost } from '../../../../shared/execution-host/execution-host'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'

/** A chat of a bot on another computer opens on that computer: its home's folder id alone can name a
 *  twin here. This machine's bots keep the default route. */
function activate(bot: Bot, sessionId: string): Promise<boolean> {
  const target = isLocalExecutionHost(bot.hostId)
    ? undefined
    : (structuredAgentSessionTargetForHost(bot.hostId) ?? undefined)
  return activateAiVaultStructuredSession(
    { structuredSession: { sessionId, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) } },
    undefined,
    target
  )
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
  // The tab must be this bot's host's: stamped with it, or unstamped on this machine's own bot.
  const ofBotHost = tab?.executionHostId
    ? tab.executionHostId === bot.hostId
    : isLocalExecutionHost(bot.hostId)
  return tab?.entityId === sessionId && ofBotHost ? tab : null
}

/** Opens one of the bot's chats as a focused tab; a thread's or a run's gets its tab here. The chat
 *  already on screen goes to its newest output, its composer focused with the usual glow. */
export function openBotSession(bot: Bot, sessionId: string): void {
  const shown = shownChatTab(bot, sessionId)
  if (shown) {
    targetBotChatLatest(sessionId)
    requestNativeChatComposerFocus(shown.id, { revealDraft: true })
    return
  }
  void activate(bot, sessionId).then((opened) => (opened ? markSeen(bot, [sessionId]) : undefined))
}
