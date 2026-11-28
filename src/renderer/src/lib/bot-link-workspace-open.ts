// `orca bot link`'s workspace link, opened in this window on the computer that lists the bot.
import type { BotDeepLinkWorkspace } from '../../../shared/bot-deep-link'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/workspace/identity/floating-workspace-worktree'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspaceWithOutcome } from './workspace/activation/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTabOnOwner
} from './agent-session/structured-agent-session-tab-activation'
import { botHostTarget } from './bot-hosts'

/** A cold protocol launch can restore tabs before its paired workspace rows arrive. */
export async function waitForBotLinkWorkspaceCatalog(signal: AbortSignal): Promise<void> {
  if (signal.aborted || useAppStore.getState().startupWorktreeRefreshCompleted) {
    return
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      unsubscribe()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.startupWorktreeRefreshCompleted) {
        finish()
      }
    })
    signal.addEventListener('abort', finish, { once: true })
  })
}

export function openBotLinkWorkspaceOnHost(
  hostId: ExecutionHostId,
  workspace: BotDeepLinkWorkspace
): boolean {
  const { worktreeId, agentSessionId } = workspace
  if (isFloatingWorkspaceId(worktreeId)) {
    return false
  }
  const outcome = activateAndRevealWorkspaceWithOutcome(worktreeId, {
    navigationIntent: 'user-open',
    executionHostId: hostId
  })
  if ('refused' in outcome) {
    return false
  }
  if (agentSessionId) {
    const target = botHostTarget(hostId)
    // Ask the owner to select a tab that has yet to appear in this window.
    if (
      !activateStructuredAgentSessionById({
        worktreeId,
        sessionId: agentSessionId,
        target,
        windowOnly: true
      })
    ) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, agentSessionId, target, {
        windowOnly: true
      })
    }
  }
  return true
}
