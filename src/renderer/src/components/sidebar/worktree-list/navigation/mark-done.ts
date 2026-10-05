import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  DONE_WORKSPACE_STATUS_ID,
  getWorkspaceStatus,
  isWorkspaceStatusId
} from '../../../../../../shared/workspace-statuses'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { getDeleteStateForWorktreeHost } from '../../worktree-delete-state-host-match'

type MarkDoneTarget = Pick<Worktree, 'id' | 'hostId'>

type MarkDoneState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'deleteStateByWorktreeId'
  | 'getKnownWorktreeById'
  | 'workspaceStatuses'
>

// Why: a multi-row selection is what the right-click status menu acts on. Otherwise the
// target is the active row, which arrows move; hover (the delete shortcut's target) is a mouse signal.
function getMarkDoneTargets(
  state: MarkDoneState,
  selectedWorktrees: readonly MarkDoneTarget[]
): readonly MarkDoneTarget[] {
  if (selectedWorktrees.length > 1) {
    // Why: a host-less lookup can return a same-path row on another host; an unhosted row is local.
    return selectedWorktrees.map(({ id, hostId }) => ({
      id,
      hostId: hostId ?? LOCAL_EXECUTION_HOST_ID
    }))
  }
  return state.activeWorktreeId
    ? [{ id: state.activeWorktreeId, hostId: state.activeWorkspaceExecutionHostId ?? undefined }]
    : []
}

function hasStatus(
  worktree: Pick<Worktree, 'workspaceStatus'> | undefined,
  status: string,
  statuses: readonly WorkspaceStatusDefinition[]
): boolean {
  return (
    worktree !== undefined &&
    isWorkspaceStatusId(status, statuses) &&
    getWorkspaceStatus(worktree, statuses) === status
  )
}

/** The rows the key would move; the only place its target and eligibility rules live. */
function resolveMarkDoneTargets(
  state: MarkDoneState,
  selectedWorktrees: readonly MarkDoneTarget[]
): readonly Worktree[] {
  const statuses = state.workspaceStatuses
  // Why: statuses are user-editable; a board without Done has nothing to move to.
  if (!statuses.some((status) => status.id === DONE_WORKSPACE_STATUS_ID)) {
    return []
  }
  return getMarkDoneTargets(state, selectedWorktrees).flatMap((target) => {
    const worktree = state.getKnownWorktreeById(target.id, target.hostId)
    if (!worktree || !hasStatus(worktree, DEFAULT_WORKSPACE_STATUS_ID, statuses)) {
      return []
    }
    // Why: the right-click status submenu is disabled mid-delete; the keyboard path matches it.
    return getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
      ? []
      : [worktree]
  })
}

function hostQualifiedKey(worktree: MarkDoneTarget): string {
  return composeWorktreeHostIdentity(worktree.hostId ?? LOCAL_EXECUTION_HOST_ID, worktree.id)
}

/** Whether the key, with `rows` as the sidebar selection, would move exactly `rows`. */
export function markDoneKeyMovesExactly(
  state: MarkDoneState,
  rows: readonly MarkDoneTarget[]
): boolean {
  const moved = resolveMarkDoneTargets(state, rows)
  const movedKeys = new Set(moved.map(hostQualifiedKey))
  return (
    moved.length === rows.length &&
    movedKeys.size === rows.length &&
    rows.every((row) => movedKeys.has(hostQualifiedKey(row)))
  )
}

/** Requests moving the key's rows to Done; true means a write was requested, not persisted. */
export function markWorkspacesDone(
  state: MarkDoneState & Pick<AppState, 'updateWorktreeMeta'>,
  selectedWorktrees: readonly MarkDoneTarget[]
): boolean {
  const statuses = state.workspaceStatuses
  const doneStatus = statuses.find((status) => status.id === DONE_WORKSPACE_STATUS_ID)
  const worktrees = resolveMarkDoneTargets(state, selectedWorktrees)
  if (!doneStatus || worktrees.length === 0) {
    return false
  }
  const writes = worktrees.map((worktree) =>
    state.updateWorktreeMeta(
      worktree.id,
      { workspaceStatus: DONE_WORKSPACE_STATUS_ID },
      {
        executionHostId: worktree.hostId ?? 'local',
        shouldApply: (current) => hasStatus(current, DEFAULT_WORKSPACE_STATUS_ID, statuses)
      }
    )
  )
  const toastId = showMarkedDoneToast(worktrees, doneStatus.label)
  reportFailedMoves(worktrees, writes, doneStatus.label, toastId)
  return true
}

const MARKED_DONE_TOAST_DURATION_MS = 10_000

// Why: a key press has no visible confirmation, and the row can move into a collapsed Done section.
function showMarkedDoneToast(worktrees: readonly Worktree[], statusLabel: string): string | number {
  const [first] = worktrees
  return toast(
    worktrees.length === 1 && first
      ? translate('auto.components.sidebar.markDone.movedOne', 'Moved {{name}} to {{status}}', {
          name: first.displayName,
          status: statusLabel
        })
      : translate(
          'auto.components.sidebar.markDone.movedMany',
          'Moved {{count}} workspaces to {{status}}',
          {
            count: worktrees.length,
            status: statusLabel
          }
        ),
    {
      // Why: the default ~4 s closes before a user who looked away can reach Undo.
      duration: MARKED_DONE_TOAST_DURATION_MS,
      action: {
        label: translate('auto.components.sidebar.markDone.undo', 'Undo'),
        onClick: () => undoMarkedDone(worktrees)
      }
    }
  )
}

function undoMarkedDone(worktrees: readonly Worktree[]): void {
  const { updateWorktreeMeta, workspaceStatuses } = useAppStore.getState()
  const inProgressStatus = workspaceStatuses.find(
    (status) => status.id === DEFAULT_WORKSPACE_STATUS_ID
  )
  if (!inProgressStatus) {
    return
  }
  const writes = worktrees.map((worktree) =>
    updateWorktreeMeta(
      worktree.id,
      { workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID },
      {
        executionHostId: worktree.hostId ?? 'local',
        // Why: a status set after the key press wins over the undo.
        shouldApply: (current) => hasStatus(current, DONE_WORKSPACE_STATUS_ID, workspaceStatuses)
      }
    )
  )
  reportFailedMoves(worktrees, writes, inProgressStatus.label)
}

type StatusWriteResult = Awaited<ReturnType<AppState['updateWorktreeMeta']>>

function getWriteError(result: PromiseSettledResult<StatusWriteResult> | undefined): string | null {
  if (!result) {
    return null
  }
  if (result.status === 'rejected') {
    return result.reason instanceof Error ? result.reason.message : String(result.reason)
  }
  return result.value.ok ? null : result.value.error
}

// Why: the toast is optimistic; a failed save (e.g. an unreachable SSH host) has already reverted the row.
function reportFailedMoves(
  worktrees: readonly Worktree[],
  writes: readonly Promise<StatusWriteResult>[],
  statusLabel: string,
  optimisticToastId?: string | number
): void {
  void Promise.allSettled(writes)
    .then((results) => {
      const failures = worktrees.flatMap((worktree, index) => {
        const error = getWriteError(results[index])
        return error === null ? [] : [{ worktree, error }]
      })
      const [first] = failures
      if (!first) {
        return
      }
      if (optimisticToastId !== undefined) {
        toast.dismiss(optimisticToastId)
      }
      toast.error(
        failures.length === 1
          ? translate(
              'auto.components.sidebar.markDone.failedOne',
              'Could not move {{name}} to {{status}}',
              { name: first.worktree.displayName, status: statusLabel }
            )
          : translate(
              'auto.components.sidebar.markDone.failedMany',
              'Could not move {{count}} workspaces to {{status}}',
              { count: failures.length, status: statusLabel }
            ),
        {
          description:
            failures.length === 1
              ? first.error
              : failures.map((failure) => failure.worktree.displayName).join(', ')
        }
      )
    })
    .catch((error: unknown) => {
      console.error('Failed to report workspace status write failures:', error)
    })
}
