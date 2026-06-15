import type { BaseRefSearchResult, Worktree } from '../../../../shared/types'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

export type BranchSwitchCandidate = {
  /** Display ref, e.g. 'origin/feature' (remote) or 'feature' (local). */
  refName: string
  /** Local branch name passed to `git switch`; git DWIMs a tracking branch. */
  branchName: string
  kind: 'local' | 'remote'
  isCurrent: boolean
  checkedOutInWorktreeId: string | null
  checkedOutInWorktreeName: string | null
}

export function annotateBranchSwitchCandidates(input: {
  refs: BaseRefSearchResult[]
  worktrees: Worktree[]
  activeWorktreeId: string | null
  activeBranchName: string
}): BranchSwitchCandidate[] {
  // Why: map each OTHER worktree's branch so we can disable + offer-jump for a
  // branch git would refuse to check out twice. Skip the active worktree.
  const byBranch = new Map<string, Worktree>()
  for (const worktree of input.worktrees) {
    if (worktree.id === input.activeWorktreeId) {
      continue
    }
    const identity = getWorktreeGitIdentityDisplay(worktree)
    if (identity?.kind === 'branch') {
      byBranch.set(identity.branchName, worktree)
    }
  }

  const seenLocal = new Set<string>()
  const candidates: BranchSwitchCandidate[] = []
  for (const ref of input.refs) {
    // Why: the ref search strips the remote prefix into localBranchName, so a
    // remote ref differs from its local name while a local ref matches it.
    const kind = ref.refName === ref.localBranchName ? 'local' : 'remote'
    // Why: a remote ref and an already-tracked local branch resolve to the same
    // switch target; collapse to the local entry to avoid a duplicate row.
    if (kind === 'remote' && seenLocal.has(ref.localBranchName)) {
      continue
    }
    if (kind === 'local') {
      seenLocal.add(ref.localBranchName)
    }
    const elsewhere = byBranch.get(ref.localBranchName) ?? null
    candidates.push({
      refName: ref.refName,
      branchName: ref.localBranchName,
      kind,
      isCurrent: ref.localBranchName === input.activeBranchName,
      checkedOutInWorktreeId: elsewhere?.id ?? null,
      checkedOutInWorktreeName: elsewhere?.displayName ?? null
    })
  }
  return candidates
}
