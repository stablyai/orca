import { defaultFilter } from 'cmdk'
import { branchDisplayName } from './WorktreeCardHelpers'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export function getWorktreeParentPickerItemValue(candidate: Worktree, repoName = ''): string {
  return `${candidate.displayName} ${branchDisplayName(candidate.branch)} ${candidate.path} ${repoName}`
}

// Score before rendering so cmdk cannot mount and reorder hundreds of sibling candidates per keystroke.
export function filterWorktreeParentCandidates(
  candidates: readonly Worktree[],
  search: string,
  repoMap?: ReadonlyMap<string, Pick<Repo, 'displayName'>>
): Worktree[] {
  const query = search.trim()
  if (!query) {
    return [...candidates]
  }
  return candidates
    .map((candidate) => ({
      candidate,
      score: defaultFilter(
        getWorktreeParentPickerItemValue(candidate, repoMap?.get(candidate.repoId)?.displayName),
        query,
        []
      )
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.candidate)
}

export function clampWorktreeParentPickerIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0
  }
  return Math.min(Math.max(index, 0), count - 1)
}
