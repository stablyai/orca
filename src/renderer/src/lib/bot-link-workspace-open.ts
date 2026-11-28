// `orca bot link`'s workspace link, opened in this window on the computer that lists the bot.
import type { BotDeepLinkWorkspace } from '../../../shared/bot-deep-link'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { activateAndRevealWorktreeWithOutcome } from './workspace/activation/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTabOnOwner
} from './agent-session/structured-agent-session-tab-activation'
import { botHostTarget } from './bot-hosts'

/**
 * Opens the workspace, and its agent's chat when the link names one, as a click on its sidebar row
 * would. A paired server's workspace opens here, in the window the person clicked from; the server's
 * own window is left alone. False when this window doesn't know the workspace.
 */
export function openBotLinkWorkspaceOnHost(
  hostId: ExecutionHostId,
  workspace: BotDeepLinkWorkspace
): boolean {
  const { worktreeId, agentSessionId } = workspace
  const outcome = activateAndRevealWorktreeWithOutcome(worktreeId, {
    navigationIntent: 'user-open',
    ...(hostId === LOCAL_EXECUTION_HOST_ID ? {} : { executionHostId: hostId })
  })
  if ('refused' in outcome) {
    return false
  }
  if (agentSessionId) {
    const target = botHostTarget(hostId)
    // A tab not in this window yet is asked of its host for this window only, never the host's own.
    // A terminal agent's session names no chat tab; the workspace alone is where it runs.
    if (!activateStructuredAgentSessionById({ worktreeId, sessionId: agentSessionId, target })) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, agentSessionId, target, {
        callerOnly: true
      })
    }
  }
  return true
}
