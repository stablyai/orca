import { defaultFilter } from 'cmdk'
import { branchDisplayName } from './WorktreeCardHelpers'
import type { Worktree } from '../../../../shared/worktree/types'

export function getWorktreeParentPickerItemValue(candidate: Worktree): string {
  return `${candidate.displayName} ${branchDisplayName(candidate.branch)} ${candidate.path}`
}

// Why: a repo with hundreds of workspaces makes every eligible sibling a
// candidate, so the list is scored here rather than handed to cmdk — cmdk
// mounts, scores and DOM-reorders every registered item on each keystroke.
export function filterWorktreeParentCandidates(
  candidates: readonly Worktree[],
  search: string
): Worktree[] {
  const query = search.trim()
  if (!query) {
    return [...candidates]
  }
  return candidates
    .map((candidate) => ({
      candidate,
      score: defaultFilter(getWorktreeParentPickerItemValue(candidate), query, [])
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
