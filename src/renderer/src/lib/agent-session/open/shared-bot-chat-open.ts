// A shared agent's host never moves a teammate's screen on its own (its activations reach only the
// owner's windows), so a chat a teammate opens is revealed for their window alone.
import { sharedBotHostOf } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { activateStructuredAgentSessionTabOnOwner } from '../structured-agent-session-tab-activation'

/** False for any other host's chat, which its host's own activation reveals. */
export function revealSharedBotChat(
  bot: { hostId: ExecutionHostId },
  worktreeId: string,
  sessionId: string
): boolean {
  if (!sharedBotHostOf(bot.hostId)) {
    return false
  }
  activateStructuredAgentSessionTabOnOwner(worktreeId, sessionId, undefined, { callerOnly: true })
  return true
}
