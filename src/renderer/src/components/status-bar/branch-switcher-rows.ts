import { branchName } from '@/lib/git-utils'
import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type BranchSwitcherRow = {
  branch: string
  label: string
  remoteOnly: boolean
}

export type WorktreeSwitcherRow = {
  id: string
  displayName: string
  branch: string
}

/** The project's other live worktrees; Git refuses to check their branches out here. */
export function otherWorktreeRows(
  worktrees: readonly Pick<Worktree, 'id' | 'displayName' | 'branch' | 'isArchived'>[],
  activeWorktreeId: string | null
): WorktreeSwitcherRow[] {
  return worktrees
    .filter((worktree) => worktree.id !== activeWorktreeId && !worktree.isArchived)
    .map((worktree) => ({
      id: worktree.id,
      displayName: worktree.displayName,
      branch: branchName(worktree.branch)
    }))
}

export function worktreeRowMatches(row: WorktreeSwitcherRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return `${row.displayName} ${row.branch}`.toLowerCase().includes(needle)
}

/** One row per branch: a local branch hides the remote refs of the same name. */
export function branchSwitcherRows(refs: readonly BaseRefSearchResult[]): BranchSwitcherRow[] {
  const rows = new Map<string, BranchSwitcherRow>()
  for (const ref of refs) {
    const remoteOnly = ref.refName !== ref.localBranchName
    if (!rows.has(ref.localBranchName) || !remoteOnly) {
      rows.set(ref.localBranchName, {
        branch: ref.localBranchName,
        label: ref.refName,
        remoteOnly
      })
    }
  }
  return [...rows.values()]
}
