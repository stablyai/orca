import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getRepoMapFromState } from '@/store/selectors'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  isAutomaticDeselection,
  subscribeWorktreeDeselectionIntent,
  type EnclosingWorktreeRemoval
} from '@/store/active-worktree-deselection-intent'
import {
  findIndexedWorktreeOwnerForHost,
  worktreeOwnerHostIds
} from '@/lib/worktree-runtime-owner-index'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
import { getDeleteStateForWorktreeHost } from '@/components/sidebar/worktree-delete-state-host-match'
import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type SuccessorState = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'repos'
  | 'deleteStateByWorktreeId'
  | 'lastVisitedAtByWorktreeId'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'activeView'
  | 'activePendingCreationId'
>

type RemovedActiveRow = {
  id: string
  hostId: ExecutionHostId | null
  repoId: string
  ownerHostIds: ExecutionHostId[]
}

function findListedRow(
  state: Pick<AppState, 'worktreesByRepo' | 'repos'>,
  worktreeId: string,
  hostId: ExecutionHostId | null
) {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const rows = selectWorktreesByRepo(state)[repoId] ?? []
  if (!hostId) {
    return rows.find((row) => row.id === worktreeId)
  }
  return findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(state), worktreeId, hostId)
}

// Per-workspace runtimes die with their workspace; choosing a sibling on that host would spawn a terminal on a dead runtime.
function isHostedOnRuntimeOwnedSshTarget(
  worktree: Pick<Worktree, 'hostId' | 'repoId'>,
  repoById: Map<string, Repo>
): boolean {
  const hostIds = [
    worktree.hostId,
    repoById.get(worktree.repoId)?.executionHostId,
    repoById.get(worktree.repoId)?.connectionId
  ]
  return hostIds.some((value) => {
    if (!value) {
      return false
    }
    // connectionId is a raw target id; executionHostId/hostId are `ssh:<targetId>`.
    if (isRuntimeOwnedSshTargetId(value)) {
      return true
    }
    const parsed = parseExecutionHostId(value)
    return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
  })
}

// Like closing a tab: the most recently visited other workspace of the project, else its main one.
export function pickActiveWorktreeSuccessor(
  state: SuccessorState,
  removed: RemovedActiveRow
): Worktree | null {
  const repoById = getRepoMapFromState(state)
  const siblings = (selectWorktreesByRepo(state)[removed.repoId] ?? []).filter(
    (worktree) =>
      !getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting &&
      !isHostedOnRuntimeOwnedSshTarget(worktree, repoById)
  )
  const others = siblings.filter((worktree) => !worktree.isMainWorktree)
  if (others.length > 0) {
    const lastVisited = state.lastVisitedAtByWorktreeId
    return [...others].sort(
      (a, b) =>
        (getWorktreeVisitTimestamp(lastVisited, b) ?? 0) -
        (getWorktreeVisitTimestamp(lastVisited, a) ?? 0)
    )[0]
  }
  return siblings.find((worktree) => worktree.isMainWorktree) ?? null
}

function listedActiveRow(state: SuccessorState): RemovedActiveRow | null {
  const id = state.activeWorktreeId
  const row = id ? findListedRow(state, id, state.activeWorkspaceExecutionHostId) : undefined
  return row && id
    ? {
        id,
        hostId: state.activeWorkspaceExecutionHostId,
        repoId: row.repoId,
        ownerHostIds: worktreeOwnerHostIds(row)
      }
    : null
}

function isSelectionEmptyTerminalView(state: SuccessorState): boolean {
  return (
    state.activeView === 'terminal' &&
    state.activePendingCreationId === null &&
    state.activeWorktreeId === null
  )
}

/** Focus a successor once the active row is gone and selection is empty. Remember the last listed active row because removal and selection clearing can arrive in either order. */
export function installActiveWorktreeRemovalSuccessor(store = useAppStore): () => void {
  let witness: RemovedActiveRow | null = null
  let generation = 0
  const scopes = new Set<EnclosingWorktreeRemoval>()
  const matchesScope = (row: RemovedActiveRow, scope: EnclosingWorktreeRemoval): boolean =>
    row.ownerHostIds.includes(scope.hostId) && (!scope.repoId || scope.repoId === row.repoId)
  const isScoped = (row: RemovedActiveRow): boolean =>
    [...scopes].some((scope) => matchesScope(row, scope))
  const observe = (): RemovedActiveRow | null => {
    const state = store.getState()
    const row =
      state.activeView === 'terminal' && state.activePendingCreationId === null
        ? listedActiveRow(state)
        : null
    return row && !isScoped(row) ? row : null
  }
  witness = observe()
  const unsubscribeIntent = subscribeWorktreeDeselectionIntent((scope, entering) => {
    if (!scope || entering) {
      if (scope) {
        scopes.add(scope)
      }
      if (!scope || (witness && isScoped(witness))) {
        witness = null
        generation += 1
      }
    } else {
      scopes.delete(scope)
      const current = observe()
      if (!witness && current && matchesScope(current, scope)) {
        witness = current
      }
    }
  })
  const unsubscribe = store.subscribe((next, prev) => {
    if (
      next.activeWorktreeId === prev.activeWorktreeId &&
      next.activeWorkspaceExecutionHostId === prev.activeWorkspaceExecutionHostId &&
      selectWorktreesByRepo(next) === selectWorktreesByRepo(prev) &&
      next.activeView === prev.activeView &&
      next.activePendingCreationId === prev.activePendingCreationId
    ) {
      return
    }
    const selectionChanged =
      next.activeWorktreeId !== null &&
      (next.activeWorktreeId !== prev.activeWorktreeId ||
        next.activeWorkspaceExecutionHostId !== prev.activeWorkspaceExecutionHostId)
    const navigated =
      selectionChanged ||
      next.activeView !== prev.activeView ||
      next.activePendingCreationId !== prev.activePendingCreationId
    if (navigated) {
      witness = null
      generation += 1
    }
    if (next.activeView !== 'terminal' || next.activePendingCreationId !== null) {
      return
    }
    if (next.activeWorktreeId !== null) {
      const listed = observe()
      // An unlisted pointer to the witness is a row dropped before its selection clears.
      if (listed || witness?.id !== next.activeWorktreeId) {
        witness = listed
      }
      return
    }
    if (!witness) {
      return
    }
    const witnessListed = Boolean(findListedRow(next, witness.id, witness.hostId))
    const rowDropped = Boolean(findListedRow(prev, witness.id, witness.hostId)) && !witnessListed
    const userCleared = prev.activeWorktreeId !== null && !rowDropped && !isAutomaticDeselection()
    if (userCleared || !isSelectionEmptyTerminalView(next)) {
      witness = null
      generation += 1
      return
    }
    if (witnessListed) {
      return
    }
    const removed = witness
    const scheduled = ++generation
    // Let removal’s synchronous follow-up writes finish before rechecking.
    queueMicrotask(() => {
      const state = store.getState()
      if (
        scheduled !== generation ||
        !isSelectionEmptyTerminalView(state) ||
        findListedRow(state, removed.id, removed.hostId)
      ) {
        return
      }
      witness = null
      const successor = pickActiveWorktreeSuccessor(state, removed)
      if (successor) {
        // Keep successor focus from replacing the removed row's spatial context.
        activateAndRevealWorktree(successor.id, {
          revealInSidebar: false,
          executionHostId: successor.hostId
        })
      }
    })
  })
  return () => {
    generation += 1
    unsubscribeIntent()
    unsubscribe()
  }
}
