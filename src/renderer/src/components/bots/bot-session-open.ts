import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { callBotRpc } from '@/lib/bot-hosts'
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

/** Opens one of the bot's chats as a focused tab; a thread's or a run's gets its tab here. */
export function openBotSession(bot: Bot, sessionId: string): void {
  void activate(bot, sessionId).then((opened) => (opened ? markSeen(bot, [sessionId]) : undefined))
}
