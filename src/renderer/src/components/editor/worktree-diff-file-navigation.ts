import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { compareGitStatusEntries } from '../right-sidebar/source-control-status-sort'
import {
  SOURCE_CONTROL_AREAS,
  type SourceControlSectionArea
} from '../right-sidebar/source-control/listing/section-order'

export type WorktreeDiffNavigationDirection = 'next' | 'previous'

export type WorktreeDiffNavigationCandidate = Pick<
  GitStatusEntry,
  'path' | 'status' | 'oldPath' | 'conflictStatus'
> & {
  area: 'unstaged' | 'untracked'
}

type AdjacentCandidateArgs = {
  candidates: readonly WorktreeDiffNavigationCandidate[]
  currentPath: string
  currentArea?: 'unstaged' | 'untracked'
  direction: WorktreeDiffNavigationDirection
}

export function getWorktreeDiffNavigationCandidates(
  entries: readonly GitStatusEntry[] | undefined,
  sourceControlGroupOrder: readonly SourceControlSectionArea[] = SOURCE_CONTROL_AREAS
): WorktreeDiffNavigationCandidate[] {
  const groups: Record<'unstaged' | 'untracked', WorktreeDiffNavigationCandidate[]> = {
    unstaged: [],
    untracked: []
  }
  const seenPaths = new Set<string>()
  for (const entry of entries ?? []) {
    if (
      (entry.area !== 'unstaged' && entry.area !== 'untracked') ||
      entry.conflictStatus === 'unresolved' ||
      seenPaths.has(entry.path)
    ) {
      continue
    }
    seenPaths.add(entry.path)
    groups[entry.area].push({
      path: entry.path,
      status: entry.status,
      area: entry.area,
      oldPath: entry.oldPath,
      conflictStatus: entry.conflictStatus
    })
  }
  groups.unstaged.sort(compareGitStatusEntries)
  groups.untracked.sort(compareGitStatusEntries)
  return sourceControlGroupOrder.flatMap((area) =>
    area === 'unstaged' || area === 'untracked' ? groups[area] : []
  )
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
