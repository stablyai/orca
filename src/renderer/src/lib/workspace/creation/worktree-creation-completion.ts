import { toast } from 'sonner'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useAppStore } from '@/store/index'
import { ensureAgentStartupInTerminal } from '@/lib/workspace/creation/new-workspace'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace/activation/workspace-activation-terminal-focus'
import { seedAgentTabStateAfterWorktreeCreate } from '@/lib/workspace/creation/worktree-creation-agent-seeds'
import type { ActivateAndRevealResult } from '@/lib/workspace/activation/worktree-activation-outcome'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'

export async function completeWorktreeCreation(args: {
  creationId: string
  request: WorktreeCreationRequest
  worktreeId: string
  structuredLaunchAccepted: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  startupTerminalTabId?: string
  startupAgent?: TuiAgent
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
      startupAgent: args.startupAgent,
      backendSpawned: args.backendSpawned
    })
  }
  const paired =
    parseExecutionHostId(request.workspaceRunContext?.hostId ?? request.executionHostId)?.kind ===
      'runtime' ||
    Boolean(runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), args.worktreeId))
  const deferred =
    !args.structuredLaunchAccepted &&
    !args.backendSpawned &&
    !args.hostPlannedStartup &&
    (!paired || request.ephemeralVmRecipe)
      ? (request.startupPlan ?? request.creationStartup?.legacy().startupPlan)
      : null
  const legacyWarning =
    !args.structuredLaunchAccepted && !args.hostPlannedStartup
      ? (request.startupPlan ?? request.creationStartup?.legacy().startupPlan)?.warning
      : undefined
  if (legacyWarning) {
    toast.info(legacyWarning)
  }
  if (deferred) {
    void ensureAgentStartupInTerminal({
      worktreeId: args.worktreeId,
      primaryTabId: args.primaryTabId,
      startup: deferred
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
