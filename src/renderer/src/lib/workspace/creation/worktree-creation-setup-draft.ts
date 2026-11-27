import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { getIndexedReposById } from '@/store/repos/repository-catalog-index'
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import { getWorktreeDeleteStateKey } from '@/store/slices/worktrees/teardown/worktree-delete-state'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-transport/delivery/pty-data-sidecar-subscriptions'
import { subscribeToPtyExit } from '@/components/terminal-pane/pty-transport/delivery/pty-dispatcher'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  createSetupWaitGate,
  SETUP_WAIT_OBSERVER_MAX_MS
} from '../../../../../shared/agent-launch/startup/setup-wait-output-gate'
import { worktreeIdsEqual } from '../../../../../shared/worktree/id'
import { hostWorktreeTarget } from '../../../../../shared/worktree/host-qualified-identity'
import { isWorktreeRetiredByRemoval } from '../../../../../shared/worktree/removal/removal-visibility'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { CreateWorktreeArgs } from '../../../../../shared/worktree/create-types'
import type { WorktreeSetupGateObserver } from './worktree-startup-payload'

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

export function keepWorktreeCreationUntilSetupSettles(
  creationId: string,
  request: WorktreeCreationRequest,
  worktree: Worktree,
  setupGateBlocked: Promise<boolean>
): void {
  const state = useAppStore.getState()
  const hostId = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  state.updatePendingWorktreeCreation(creationId, {
    status: 'waiting-for-setup',
    worktreeId: worktree.id,
    loaderVisible: true,
    request: { ...request, executionHostId: hostId }
  })
  if (state.activePendingCreationId === creationId) {
    state.setActivePendingWorktreeCreation(null)
  }

  void setupGateBlocked
    .then(async (blocked) => {
      const beforeDelete = useAppStore.getState()
      if (!blocked) {
        beforeDelete.removePendingWorktreeCreation(creationId, { cleanupVm: false })
        return
      }
      if (!beforeDelete.pendingWorktreeCreations[creationId]) {
        return
      }
      const deleteKey = getWorktreeDeleteStateKey(beforeDelete, worktree.id, hostId)
      if (beforeDelete.deleteStateByWorktreeId[deleteKey]?.isDeleting) {
        // A refused deletion still owns its workspace and draft.
        await new Promise<void>((resume) => {
          const unsubscribe = useAppStore.subscribe((next) => {
            if (
              !next.pendingWorktreeCreations[creationId] ||
              !next.deleteStateByWorktreeId[deleteKey]?.isDeleting
            ) {
              unsubscribe()
              resume()
            }
          })
        })
      }
      const live = useAppStore.getState()
      const entry = live.pendingWorktreeCreations[creationId]
      if (!entry) {
        return
      }
      const current = selectWorkspaceByHostTarget(
        live,
        hostWorktreeTarget({ id: worktree.id, hostId })
      )
      if (
        !current ||
        !worktree.instanceId ||
        current.instanceId !== worktree.instanceId ||
        isWorktreeRetiredByRemoval(current) ||
        !getIndexedReposById(live.repos, request.repoId).some(
          (repo) => getRepoExecutionHostId(repo) === hostId
        )
      ) {
        live.removePendingWorktreeCreation(creationId, { cleanupVm: false })
        return
      }
      live.updatePendingWorktreeCreation(
        creationId,
        deferredWorktreeCreationDraft(current.id, entry.request, hostId)
      )
      if (
        live.activeView === 'terminal' &&
        live.activePendingCreationId === null &&
        live.activeWorktreeId !== null &&
        worktreeIdsEqual(live.activeWorktreeId, worktree.id) &&
        (live.activeWorkspaceExecutionHostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
      ) {
        live.setActivePendingWorktreeCreation(creationId)
      }
    })
    .catch(console.error)
}

export function observeRendererSetupGate(): {
  observer: WorktreeSetupGateObserver
  promise: Promise<boolean>
} {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let stopWatching: (() => void) | undefined
  let settled = false
  const settle = (blocked: boolean): void => {
    settled = true
    clearTimeout(deadline)
    stopWatching?.()
    stopWatching = undefined
    resolve(blocked)
  }
  const deadline = setTimeout(() => settle(false), SETUP_WAIT_OBSERVER_MAX_MS)
  return {
    promise,
    observer: {
      settle,
      bind: (ptyId) => {
        if (settled || stopWatching) {
          return
        }
        // A PTY's setup can outlive the pane that launched it.
        const gate = createSetupWaitGate(true)
        const stopData = subscribeToPtyData(ptyId, (data) => {
          const { phase, blocked } = gate.observe(data)
          if (phase === 'started' || phase === 'failed') {
            settle(blocked === true)
          }
        })
        const stopExit = subscribeToPtyExit(ptyId, () => settle(false))
        stopWatching = () => {
          stopData()
          stopExit()
        }
      }
    }
  }
}
