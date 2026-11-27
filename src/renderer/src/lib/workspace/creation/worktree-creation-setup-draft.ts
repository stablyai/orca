import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import { getWorktreeDeleteStateKey } from '@/store/slices/worktrees/teardown/worktree-delete-state'
import { hasWorktreeTeardownStarted } from '@/store/slices/worktrees/teardown/worktree-delete-state-types'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { worktreeIdsEqual } from '../../../../../shared/worktree/id'
import { hostWorktreeTarget } from '../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { CreateWorktreeArgs } from '../../../../../shared/worktree/create-types'

const setupGateObservers = new Map<string, (blocked: boolean) => void>()

export async function createLocalWorktreeObservingSetupGate(
  args: CreateWorktreeArgs,
  hasDraft: boolean
): Promise<CreatedWorktreeResult> {
  const { creationId } = args
  if (!hasDraft || !creationId || args.startup?.launchConfig?.commandProvenance !== 'generated') {
    return window.api.worktrees.create(args)
  }
  // The gate can settle before the create reply. Start listening before opening the worktree.
  const { promise, resolve } = Promise.withResolvers<boolean>()
  setupGateObservers.set(creationId, resolve)
  try {
    const result = await window.api.worktrees.create({ ...args, reportSetupGateOutcome: true })
    if (result.startupTerminal?.reportsSetupGateOutcome) {
      return { ...result, setupGateBlocked: promise }
    }
    setupGateObservers.delete(creationId)
    return result
  } catch (error) {
    setupGateObservers.delete(creationId)
    throw error
  }
}

export function settleWorktreeCreationSetupGate(creationId: string, blocked: boolean): void {
  const resolve = setupGateObservers.get(creationId)
  setupGateObservers.delete(creationId)
  resolve?.(blocked)
}

export function deferredWorktreeCreationDraft(
  worktreeId: string,
  request: WorktreeCreationRequest,
  executionHostId?: ExecutionHostId
): Pick<
  PendingWorktreeCreation,
  'worktreeId' | 'status' | 'startupDraftDeferred' | 'error' | 'request'
> {
  return {
    worktreeId,
    status: 'error',
    startupDraftDeferred: true,
    error: translate(
      'worktree.creation.startupDraftDeferred',
      'Your worktree is ready. The agent draft is still available here.'
    ),
    request: {
      ...request,
      executionHostId: executionHostId ?? request.executionHostId,
      startup: undefined,
      startupPlan: null,
      creationStartup: undefined
    }
  }
}

function restoreSetupBlockedWorktreeDraft(
  entry: PendingWorktreeCreation,
  worktree: Pick<Worktree, 'id' | 'hostId' | 'instanceId'>
): void {
  const state = useAppStore.getState()
  const hostId = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  const current = selectWorkspaceByHostTarget(
    state,
    hostWorktreeTarget({ id: worktree.id, hostId })
  )
  if (
    !current ||
    !worktree.instanceId ||
    current.instanceId !== worktree.instanceId ||
    current.removing ||
    hasWorktreeTeardownStarted(
      state.deleteStateByWorktreeId[getWorktreeDeleteStateKey(state, current.id, hostId)]
    )
  ) {
    return
  }
  const isViewingWorktree =
    state.activeView === 'terminal' &&
    state.activePendingCreationId === null &&
    state.activeWorktreeId !== null &&
    worktreeIdsEqual(state.activeWorktreeId, worktree.id) &&
    (state.activeWorkspaceExecutionHostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
  state.beginPendingWorktreeCreation(
    { ...entry, ...deferredWorktreeCreationDraft(current.id, entry.request, hostId) },
    isViewingWorktree
  )
}

export function retainDraftIfSetupBlocks(
  creationId: string,
  request: WorktreeCreationRequest,
  worktree: Worktree,
  setupGateBlocked: Promise<boolean> | undefined
): void {
  if (!setupGateBlocked) {
    return
  }
  const pendingEntry = useAppStore.getState().pendingWorktreeCreations[creationId]
  if (pendingEntry) {
    const entry = { ...pendingEntry, request }
    void setupGateBlocked
      .then((blocked) => {
        if (blocked) {
          restoreSetupBlockedWorktreeDraft(entry, worktree)
        }
      })
      .catch(console.error)
  }
}
