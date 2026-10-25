import {
  gateWorktreeAgentActivation,
  type WorktreeAgentActivationOutcome
} from './worktree-agent-activation-gate'
import {
  reseedGatedEmptyWorkspace,
  type GatedEmptyWorkspaceReseedIntent
} from './worktree-initial-terminal-seeding'
import {
  emptyWorkspaceDefaultChatAwaitsDetection,
  loadEmptyWorkspaceDefaultChatDetection
} from './empty-workspace-default-agent-chat'
import {
  claimEmptyWorkspaceDefaultSurface,
  isEmptyWorkspaceDefaultSurfacePending,
  releaseEmptyWorkspaceDefaultSurface
} from './empty-workspace-default-surface-claims'

const latestReseedIntentByGate = new WeakMap<
  Promise<WorktreeAgentActivationOutcome>,
  GatedEmptyWorkspaceReseedIntent
>()

export function gateAndReseedEmptyWorkspace(
  workspaceKey: string,
  intent: GatedEmptyWorkspaceReseedIntent
): void {
  const gate = gateWorktreeAgentActivation(workspaceKey)
  latestReseedIntentByGate.set(gate, intent)
  void gate.then((outcome) => {
    if (latestReseedIntentByGate.get(gate) !== intent) {
      return
    }
    latestReseedIntentByGate.delete(gate)
    if (outcome !== 'empty') {
      return
    }
    const awaitsDetection =
      intent.seedUserDefaultSurface && emptyWorkspaceDefaultChatAwaitsDetection(workspaceKey)
    if (!awaitsDetection && !isEmptyWorkspaceDefaultSurfacePending(workspaceKey)) {
      reseedGatedEmptyWorkspace(workspaceKey, intent)
      return
    }
    // Why: the default agent depends on the host's list; seeding before it loads locks in a shell.
    // A wait already pending takes this later intent instead, so the latest activation wins.
    if (!claimEmptyWorkspaceDefaultSurface(workspaceKey, intent)) {
      return
    }
    const settle = (): void => {
      const latestIntent = releaseEmptyWorkspaceDefaultSurface(workspaceKey)
      // Re-checks the active workspace, host, and emptiness the wait may have changed.
      if (latestIntent) {
        reseedGatedEmptyWorkspace(workspaceKey, latestIntent)
      }
    }
    void loadEmptyWorkspaceDefaultChatDetection(workspaceKey).then(settle, settle)
  })
}
