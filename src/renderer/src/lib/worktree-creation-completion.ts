import { useAppStore } from '@/store'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { seedAgentTabStateAfterWorktreeCreate } from '@/lib/worktree-creation-agent-seeds'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

export async function completeWorktreeCreation(args: {
  creationId: string
  request: WorktreeCreationRequest
  worktreeId: string
  structuredLaunchAccepted: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  startupTerminalTabId?: string
  backendSpawned: boolean
  /** The host was asked to plan the agent launch, so the desktop's plan never runs. */
  hostPlannedStartup: boolean
  focusOnCompletion: boolean
}): Promise<void> {
  const { request } = args
  // Why: clearing synchronously after activation lets React commit the panel-to-terminal swap in one frame.
  useAppStore.getState().removePendingWorktreeCreation(args.creationId, { cleanupVm: false })
  // Why: an agent the host planned but did not start has no tab to seed and is not the window's to start.
  const hostAgentMissing = args.hostPlannedStartup && !args.backendSpawned
  if (!args.structuredLaunchAccepted && !hostAgentMissing) {
    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: args.worktreeId,
      primaryTabId: args.primaryTabId,
      startupTerminalTabId: args.startupTerminalTabId,
      backendSpawned: args.backendSpawned
    })
  }
  if (
    !args.structuredLaunchAccepted &&
    request.startupPlan &&
    !args.backendSpawned &&
    !args.hostPlannedStartup
  ) {
    void ensureAgentStartupInTerminal({
      worktreeId: args.worktreeId,
      primaryTabId: args.primaryTabId,
      startup: request.startupPlan
    })
  }
  if (
    !args.structuredLaunchAccepted &&
    !request.suppressTerminalFocusOnCompletion &&
    args.focusOnCompletion
  ) {
    queueWorkspaceActivationTerminalFocus(args.worktreeId, args.activation)
  }

  // Why: note persistence is cosmetic and should not delay the visible workspace handoff.
  if (request.note) {
    try {
      await useAppStore.getState().updateWorktreeMeta(args.worktreeId, { comment: request.note })
    } catch {
      console.error('Failed to update worktree meta after creation')
    }
  }
}
