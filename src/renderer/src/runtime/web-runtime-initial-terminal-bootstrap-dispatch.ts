import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import {
  loadEmptyWorkspaceDefaultChatDetection,
  openDefaultAgentChatInEmptyWorkspace
} from '@/lib/empty-workspace-default-agent-chat'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './web-session-tabs-sync/mirrored-workspace-owner'
import { useAppStore } from '../store'
import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  markWebRuntimeInitialTerminalBootstrapAwaitingMirror
} from './web-runtime-initial-terminal-bootstrap'

function canSeedDefaultSurface(environmentId: string, worktreeId: string): boolean {
  const state = useAppStore.getState()
  return (
    state.activeWorktreeId === worktreeId &&
    mirroredRuntimeEnvironmentIdForWorkspace(state, worktreeId) === environmentId &&
    state.reconcileWorktreeTabModel(worktreeId).renderableTabCount === 0
  )
}

async function seedDefaultShell(environmentId: string, worktreeId: string): Promise<boolean> {
  const outcome = await createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId,
    activate: true
  })
  return outcome.status !== 'failed'
}

/** Claim per-environment/worktree bootstrap across subscription closures. Thrown/returned failures release and return false so closure-local guards can retry. Success releases if a mirrored row exists, else awaits the next accepted frame: an empty refresh may precede host publication, so immediate release risks duplicate creation. */
export async function dispatchWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): Promise<boolean> {
  if (!beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)) {
    return false
  }
  try {
    let openedChat = false
    if (isNativeChatEnabled(useAppStore.getState().settings)) {
      await loadEmptyWorkspaceDefaultChatDetection(worktreeId)
      if (!canSeedDefaultSurface(environmentId, worktreeId)) {
        endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
        return false
      }
      const chat = openDefaultAgentChatInEmptyWorkspace(worktreeId, async () => {
        if (!canSeedDefaultSurface(environmentId, worktreeId)) {
          return false
        }
        return seedDefaultShell(environmentId, worktreeId)
      })
      if (chat) {
        const settled = await chat.structuredSettlement
        if (settled && !['structured', 'terminal', 'visibility-unknown'].includes(settled.kind)) {
          endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
          return false
        }
        openedChat = true
      }
    }
    if (!openedChat && !(await seedDefaultShell(environmentId, worktreeId))) {
      endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
      return false
    }
  } catch (error) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    throw error
  }
  if (Object.hasOwn(useAppStore.getState().tabsByWorktree, worktreeId)) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  } else {
    markWebRuntimeInitialTerminalBootstrapAwaitingMirror(environmentId, worktreeId)
  }
  return true
}
