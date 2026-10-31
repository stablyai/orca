import { create } from 'zustand'
import type { GitStatusResult } from '../../../shared/git-status-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { HostScopedWorktreeKey } from '../../../shared/worktree/host-qualified-identity'

/** Uncommitted-change count for one checkout; capped means git stopped listing at its limit. */
export type WorktreeChangeSummary = {
  changeCount: number
  capped: boolean
}

type WorktreeChangeSummaryState = {
  // Host-qualified: bare worktree ids repeat across hosts, unlike gitStatusByWorktree's keys.
  summaryByIdentity: ReadonlyMap<HostScopedWorktreeKey, WorktreeChangeSummary>
  /** Sidebar cards currently on screen; the refresher reads only these to bound git work. */
  visibleWorktrees: readonly Worktree[]
  setSummary: (identity: HostScopedWorktreeKey, summary: WorktreeChangeSummary) => void
  setVisibleWorktrees: (worktrees: readonly Worktree[]) => void
}

export function summarizeGitStatus(
  status: Pick<GitStatusResult, 'entries' | 'didHitLimit'>
): WorktreeChangeSummary {
  return { changeCount: status.entries.length, capped: status.didHitLimit === true }
}

function sameWorktreeList(left: readonly Worktree[], right: readonly Worktree[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (worktree, index) =>
        worktree.id === right[index]?.id && worktree.hostId === right[index]?.hostId
    )
  )
}

export const useWorktreeChangeSummaryStore = create<WorktreeChangeSummaryState>()((set) => ({
  summaryByIdentity: new Map(),
  visibleWorktrees: [],
  setSummary: (identity, summary) =>
    set((state) => {
      const previous = state.summaryByIdentity.get(identity)
      if (previous?.changeCount === summary.changeCount && previous.capped === summary.capped) {
        return state
      }
      return { summaryByIdentity: new Map(state.summaryByIdentity).set(identity, summary) }
    }),
  setVisibleWorktrees: (worktrees) =>
    set((state) =>
      sameWorktreeList(state.visibleWorktrees, worktrees) ? state : { visibleWorktrees: worktrees }
    )
}))
