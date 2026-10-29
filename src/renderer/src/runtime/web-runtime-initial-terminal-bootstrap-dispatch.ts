import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import {
  loadEmptyWorkspaceDefaultChatDetection,
  openDefaultAgentChatInEmptyWorkspace
} from '@/lib/empty-workspace-default-agent-chat'
import { useAppStore } from '../store'
import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'
import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  markWebRuntimeInitialTerminalBootstrapAwaitingMirror
} from './web-runtime-initial-terminal-bootstrap'

/** Claim per-environment/worktree bootstrap across subscription closures. Thrown/returned failures release and return false so closure-local guards can retry. Success releases if a mirrored row exists, else awaits the next accepted frame: an empty refresh may precede host publication, so immediate release risks duplicate creation. */
export async function dispatchWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): Promise<boolean> {
  if (!beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)) {
    return false
  }
  let outcome: WebRuntimeTerminalCreateOutcome
  try {
    if (isNativeChatEnabled(useAppStore.getState().settings)) {
      await loadEmptyWorkspaceDefaultChatDetection(worktreeId)
      if (useAppStore.getState().activeWorktreeId !== worktreeId) {
        endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
        return false
      }
      const chat = openDefaultAgentChatInEmptyWorkspace(worktreeId, () => {
        endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
        return false
      })
      if (chat) {
        markWebRuntimeInitialTerminalBootstrapAwaitingMirror(environmentId, worktreeId)
        return true
      }
    }
    outcome = await createWebRuntimeSessionTerminal({ worktreeId, environmentId, activate: true })
  } catch (error) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    throw error
  }
  // RPC/network failures return failed rather than throw; release both shared and caller-local guards.
  if (outcome.status === 'failed') {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    return false
  }
  if (Object.hasOwn(useAppStore.getState().tabsByWorktree, worktreeId)) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  } else {
    markWebRuntimeInitialTerminalBootstrapAwaitingMirror(environmentId, worktreeId)
  }
  return true
}
