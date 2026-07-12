import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo, Worktree } from '../../../../shared/types'

type AppStoreState = ReturnType<typeof useAppStore.getState>

// Why: a per-workspace-env's runtime-owned SSH target is torn down when the workspace is deleted,
// so re-focusing a sibling hosted on that same target would land on a dead runtime and auto-create
// a terminal that can never spawn (a blank, stuck pane). Treat such siblings as not focus-eligible.
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

// Why: after deleting the workspace the user is currently viewing, leaving the
// active workspace empty loses their place. Pick the next workspace to focus
// so a delete behaves like closing a tab — prefer another non-base/primary
// workspace of the same project (most-recently-visited first), and fall back to
// the project's base/primary workspace when no other workspace remains.
function pickNextWorktreeIdAfterDelete(
  state: AppStoreState,
  repoId: string,
  deletedWorktreeId: string
): string | null {
  const deleteState = state.deleteStateByWorktreeId
  const repoById = getRepoMapFromState(state)
  const siblings = (state.worktreesByRepo[repoId] ?? []).filter(
    (worktree) =>
      worktree.id !== deletedWorktreeId &&
      !deleteState[worktree.id]?.isDeleting &&
      // Skip siblings hosted on the now-destroyed runtime-owned SSH target (see helper).
      !isHostedOnRuntimeOwnedSshTarget(worktree, repoById)
  )
  const others = siblings.filter((worktree) => !worktree.isMainWorktree)
  if (others.length > 0) {
    const lastVisited = state.lastVisitedAtByWorktreeId
    const [mostRecent] = [...others].sort(
      (a, b) => (lastVisited[b.id] ?? 0) - (lastVisited[a.id] ?? 0)
    )
    return mostRecent.id
  }
  return siblings.find((worktree) => worktree.isMainWorktree)?.id ?? null
}

function focusNextWorktreeAfterActiveDelete(
  deletedWorktreeId: string,
  repoId: string | null,
  wasViewingBeforeDelete: boolean
): void {
  if (!wasViewingBeforeDelete || !repoId) {
    return
  }
  const state = useAppStore.getState()
  // Why: a concurrent activation may have already moved focus during the delete.
  // Only hand off when deletion left the terminal workspace selection empty.
  if (
    state.activeView !== 'terminal' ||
    state.activePendingCreationId !== null ||
    state.activeWorktreeId !== null
  ) {
    return
  }
  const nextWorktreeId = pickNextWorktreeIdAfterDelete(state, repoId, deletedWorktreeId)
  if (nextWorktreeId) {
    activateAndRevealWorktree(nextWorktreeId)
  }
}

/**
 * Capture, before a delete runs, whether the target is the workspace the user is
 * currently viewing. Returns a committer to call after a successful delete: it
 * focuses the next-best workspace only when the deleted one was active, so
 * deleting a background workspace never steals the user's current focus.
 *
 * Captured up front because the worktree record (and its repoId) is gone from the
 * store once the delete resolves.
 */
export function prepareActiveWorktreeFocusAfterDelete(worktreeId: string): () => void {
  const state = useAppStore.getState()
  const wasViewing =
    state.activeView === 'terminal' &&
    state.activePendingCreationId === null &&
    state.activeWorktreeId === worktreeId
  const repoId = getWorktreeMapFromState(state).get(worktreeId)?.repoId ?? null
  return () => focusNextWorktreeAfterActiveDelete(worktreeId, repoId, wasViewing)
}
