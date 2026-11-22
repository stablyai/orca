import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { compareGitStatusEntries } from '../../../../../../shared/git/status/git-status-sort'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import {
  buildSourceControlDisplaySections,
  groupSourceControlEntries,
  type SourceControlDisplaySectionArea
} from '../../../../../../shared/source-control/listing/source-control-section-order'
import {
  buildGitStatusSourceControlTree,
  collectSourceControlTreeFileEntries,
  compactSourceControlTree
} from '../../../../../../shared/source-control/listing/source-control-tree'

export type WorktreeDiffNavigationDirection = 'next' | 'previous'

export type WorktreeDiffNavigationCandidate = Pick<
  GitStatusEntry,
  'path' | 'status' | 'oldPath' | 'conflictStatus'
> & {
  area: 'unstaged' | 'untracked'
}

type WorktreeDiffNavigationOrder = {
  groupOrder: readonly SourceControlDisplaySectionArea[]
  viewMode: SourceControlViewMode
}

type AdjacentCandidateArgs = {
  candidates: readonly WorktreeDiffNavigationCandidate[]
  currentPath: string
  currentArea?: 'unstaged' | 'untracked'
  direction: WorktreeDiffNavigationDirection
}

// Follow Source Control's own sections (group order, untracked folded into Changes, tree depth-first) so the sweep visits files in the order the panel displays them.
export function getWorktreeDiffNavigationCandidates(
  entries: readonly GitStatusEntry[] | undefined,
  { groupOrder, viewMode }: WorktreeDiffNavigationOrder
): WorktreeDiffNavigationCandidate[] {
  const sections = buildSourceControlDisplaySections(
    groupSourceControlEntries(entries ?? []),
    groupOrder
  )
  const candidates: WorktreeDiffNavigationCandidate[] = []
  for (const section of sections) {
    // Staged-only rows and the pinned conflict section stay outside the worktree review sweep.
    if (section.id === 'conflicts' || section.id === 'staged') {
      continue
    }
    const items =
      viewMode === 'tree'
        ? compactSourceControlTree(
            buildGitStatusSourceControlTree(section.area, section.items)
          ).flatMap((node) => collectSourceControlTreeFileEntries(node))
        : section.items
    for (const entry of items) {
      if (entry.area === 'staged') {
        continue
      }
      candidates.push({
        path: entry.path,
        status: entry.status,
        area: entry.area,
        oldPath: entry.oldPath,
        conflictStatus: entry.conflictStatus
      })
    }
  }
  return candidates
}

export function getAdjacentWorktreeDiffCandidate({
  candidates,
  currentPath,
  currentArea = 'unstaged',
  direction
}: AdjacentCandidateArgs): WorktreeDiffNavigationCandidate | null {
  if (candidates.length <= 1) {
    return null
  }

  const currentIndex = candidates.findIndex((candidate) => candidate.path === currentPath)
  if (currentIndex !== -1) {
    return candidates[wrapIndex(currentIndex + (direction === 'next' ? 1 : -1), candidates.length)]
  }

  const insertionIndex = findInsertionIndex(candidates, currentPath, currentArea)
  const targetIndex =
    direction === 'next'
      ? wrapIndex(insertionIndex, candidates.length)
      : wrapIndex(insertionIndex - 1, candidates.length)
  return candidates[targetIndex]
}

function findInsertionIndex(
  candidates: readonly WorktreeDiffNavigationCandidate[],
  currentPath: string,
  currentArea: 'unstaged' | 'untracked'
): number {
  const currentEntry: GitStatusEntry = { path: currentPath, status: 'modified', area: currentArea }
  const areaStart = candidates.findIndex((candidate) => candidate.area === currentArea)
  if (areaStart === -1) {
    return 0
  }
  let areaEnd = areaStart
  while (areaEnd < candidates.length && candidates[areaEnd]?.area === currentArea) {
    areaEnd += 1
  }
  return findAreaInsertionIndex(candidates, areaStart, areaEnd, currentEntry)
}

function findAreaInsertionIndex(
  candidates: readonly WorktreeDiffNavigationCandidate[],
  start: number,
  end: number,
  currentEntry: GitStatusEntry
): number {
  let low = start
  let high = end
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (compareGitStatusEntries(candidates[mid], currentEntry) < 0) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length
}
