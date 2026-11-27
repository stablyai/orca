import type { StartupDraftReceipt } from '../../../../../shared/worktree/creation/startup-draft-receipt'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { waitForStartupDraftOutcome } from './worktree-startup-draft-recovery'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
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
  startupDraftDeferred?: boolean
  startupDraftReceipt?: StartupDraftReceipt
  /** The host was asked to plan the agent launch, so the desktop's plan never runs. */
  hostPlannedStartup: boolean
  focusOnCompletion: boolean
}): Promise<void> {
  const { request } = args
  const store = useAppStore.getState()
  const finish = (): void =>
    useAppStore.getState().removePendingWorktreeCreation(args.creationId, { cleanupVm: false })
  if (args.startupDraftReceipt) {
    store.updatePendingWorktreeCreation(args.creationId, {
      worktreeId: args.worktreeId,
      status: 'settling-startup',
      loaderVisible: false
    })
    if (store.activePendingCreationId === args.creationId) {
      store.setActivePendingWorktreeCreation(null)
    }
  } else if (args.startupDraftDeferred) {
    useAppStore.getState().updatePendingWorktreeCreation(args.creationId, {
      worktreeId: args.worktreeId,
      status: 'error',
      startupDraftDeferred: true,
      error: translate(
        'worktree.creation.startupDraftDeferred',
        'Your worktree is ready. The agent draft is still available here.'
      ),
      request
    })
  } else {
    // Why: clearing synchronously after activation lets React commit the panel-to-terminal swap in one frame.
    finish()
  }
  const seedAndDeliver = (): void => {
    // Why: an agent the host planned but did not start has no tab to seed and is not the window's to start.
    const hostAgentMissing = args.hostPlannedStartup && !args.backendSpawned
    if (!args.startupDraftDeferred && !args.structuredLaunchAccepted && !hostAgentMissing) {
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
      (!paired || request.ephemeralVmRecipe || args.startupDraftReceipt)
        ? (request.startupPlan ?? request.creationStartup?.legacy().startupPlan)
        : null
    if (deferred) {
      void ensureAgentStartupInTerminal({
        worktreeId: args.worktreeId,
        primaryTabId: args.primaryTabId,
        startup: deferred
      })
    }
  }
  if (args.startupDraftReceipt) {
    const hostId =
      request.workspaceRunContext?.hostId ??
      request.executionHostId ??
      getResolvedExecutionHostIdForWorktree(useAppStore.getState(), args.worktreeId) ??
      'local'
    void waitForStartupDraftOutcome(hostId, args.startupDraftReceipt).then((outcome) => {
      finish()
      if (outcome === 'started') {
        seedAndDeliver()
      }
    })
  } else {
    seedAndDeliver()
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
