// A teammate's chats on a shared agent's host run in the background there (no host tab), so one is
// opened the way History opens a chat: the host reveals it for this window alone.
import { sharedBotHostOf } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { botHostTarget } from '../../bot-hosts'
import { openExistingStructuredSession } from './open-existing-structured-session'

/** False for any other host's chat, which its host's own activation reveals. */
export function revealSharedBotChat(
  bot: { hostId: ExecutionHostId },
  worktreeId: string,
  sessionId: string
): boolean {
  if (!sharedBotHostOf(bot.hostId)) {
    return false
  }
  void openExistingStructuredSession(
    { workspaceId: worktreeId, sessionId },
    { target: botHostTarget(bot.hostId), present: () => {} }
  ).catch((error: unknown) => console.error('Failed to open the shared chat:', error))
  return true
}
