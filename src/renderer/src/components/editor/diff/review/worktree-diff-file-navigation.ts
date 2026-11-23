import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
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
import {
  filterSourceControlPathEntries,
  getSourceControlFileFilterState
} from '../../../right-sidebar/source-control/listing/file-filter'

export type WorktreeDiffNavigationDirection = 'next' | 'previous'

export type WorktreeDiffNavigationCandidate = Pick<
  GitStatusEntry,
  'path' | 'status' | 'oldPath' | 'conflictStatus'
> & {
  area: 'unstaged' | 'untracked'
}

export type WorktreeDiffNavigationOrder = {
  groupOrder: readonly SourceControlDisplaySectionArea[]
  viewMode: SourceControlViewMode
  filterQuery?: string
}

type AdjacentCandidateArgs = {
  entries: readonly GitStatusEntry[] | undefined
  order: WorktreeDiffNavigationOrder
  currentPath: string
  currentArea?: 'unstaged' | 'untracked'
  direction: WorktreeDiffNavigationDirection
}

// Follow Source Control's own sections (group order, filter, untracked folded into Changes, tree depth-first) so the sweep visits files in the order the panel displays them.
export function getWorktreeDiffNavigationCandidates(
  entries: readonly GitStatusEntry[] | undefined,
  order: WorktreeDiffNavigationOrder
): WorktreeDiffNavigationCandidate[] {
  const filterState = getSourceControlFileFilterState(order.filterQuery ?? '')
  const filtered = filterSourceControlPathEntries([...(entries ?? [])], filterState)
  const sections = buildSourceControlDisplaySections(
    groupSourceControlEntries(filtered),
    order.groupOrder
  )
  const candidates: WorktreeDiffNavigationCandidate[] = []
  for (const section of sections) {
    // Staged-only rows and the pinned conflict section stay outside the worktree review sweep.
    if (section.id === 'conflicts' || section.id === 'staged') {
      continue
    }
    const items =
      order.viewMode === 'tree'
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

// No cross-file wrap: the ends of the list hand back to the caller's same-file wrap.
export function getAdjacentWorktreeDiffCandidate({
  entries,
  order,
  currentPath,
  currentArea = 'unstaged',
  direction
}: AdjacentCandidateArgs): WorktreeDiffNavigationCandidate | null {
  const candidates = getWorktreeDiffNavigationCandidates(entries, order)
  const currentIndex = candidates.findIndex((candidate) => candidate.path === currentPath)
  if (currentIndex === -1) {
    return findAdjacentOfDisappearedPath({ entries, order, currentPath, currentArea, direction })
  }
  return candidateAt(candidates, currentIndex + (direction === 'next' ? 1 : -1))
}

// Locate a path the status refresh dropped by projecting it alongside the real entries, which also places it correctly in tree and filtered order.
function findAdjacentOfDisappearedPath({
  entries,
  order,
  currentPath,
  currentArea,
  direction
}: {
  entries: readonly GitStatusEntry[] | undefined
  order: WorktreeDiffNavigationOrder
  currentPath: string
  currentArea: 'unstaged' | 'untracked'
  direction: WorktreeDiffNavigationDirection
}): WorktreeDiffNavigationCandidate | null {
  const positioned = getWorktreeDiffNavigationCandidates(
    [...(entries ?? []), { path: currentPath, status: 'modified', area: currentArea }],
    order
  )
  const insertedIndex = positioned.findIndex((candidate) => candidate.path === currentPath)
  if (insertedIndex === -1) {
    return null
  }
  return candidateAt(positioned, insertedIndex + (direction === 'next' ? 1 : -1))
}

function candidateAt(
  candidates: readonly WorktreeDiffNavigationCandidate[],
  index: number
): WorktreeDiffNavigationCandidate | null {
  return index >= 0 && index < candidates.length ? (candidates[index] ?? null) : null
}
