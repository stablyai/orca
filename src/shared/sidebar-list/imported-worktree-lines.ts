import type { Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import { getRepoExecutionHostIdOrDefault, getWorktreeExecutionHostId } from '../execution-host'
import { PINNED_GROUP_KEY } from './group-keys'
import type { NoticeHostContext } from './host-labels'
import { buildImportedWorktreesCardRow } from './row-builders'
import type { ImportedWorktreesCardCandidate, RepoOfWorktree, Row } from './row-types'

/**
 * Outside project grouping no header owns a project, so each project's hidden-worktrees line
 * follows the card holding its last rendered row: in the first open section that shows the
 * project, else Pinned (after the Pinned header while Pinned is collapsed). Placement reads the
 * rows that actually rendered, so a row hidden under a collapsed lineage never claims the line.
 */
export function placeImportedWorktreeLines(
  rows: Row[],
  args: {
    importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
    pinnedSectionWorktrees: readonly Worktree[]
    collapsedGroups: ReadonlySet<string>
    repoOf: RepoOfWorktree
    defaultHostId: ExecutionHostId
    noticeHostContextLabelByRepoId?: ReadonlyMap<string, NoticeHostContext>
  }
): Row[] {
  const { importedWorktreesByRepo, defaultHostId } = args
  if (importedWorktreesByRepo.size === 0) {
    return rows
  }
  // Same-id registrations on other hosts render in their own host sections, so only the
  // candidate's own host may anchor its line.
  const isCandidateHost = (repoId: string, hostId: ExecutionHostId): boolean => {
    const candidate = importedWorktreesByRepo.get(repoId)
    return (
      candidate !== undefined &&
      getRepoExecutionHostIdOrDefault(candidate.repo, defaultHostId) === hostId
    )
  }

  const naturalSectionByRepoId = new Map<string, string>()
  const naturalAnchorByRepoId = new Map<string, number>()
  const pinnedAnchorByRepoId = new Map<string, number>()
  let pinnedHeaderIndex = -1
  let cardEnd = -1
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (row.type === 'header' && row.key === PINNED_GROUP_KEY) {
      pinnedHeaderIndex = index
    }
    if (row.type !== 'item') {
      continue
    }
    if (index > cardEnd) {
      // A lineage card is its depth-0 root plus the deeper rows right after it.
      cardEnd = index
      while (rows[cardEnd + 1]?.type === 'item' && (rows[cardEnd + 1] as typeof row).depth > 0) {
        cardEnd++
      }
    }
    const repoId = row.worktree.repoId
    if (
      !isCandidateHost(repoId, getWorktreeExecutionHostId(row.worktree, row.repo, defaultHostId))
    ) {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY) {
      pinnedAnchorByRepoId.set(repoId, cardEnd)
      continue
    }
    const section = naturalSectionByRepoId.get(repoId)
    if (section === undefined) {
      naturalSectionByRepoId.set(repoId, row.sectionKey)
    } else if (section !== row.sectionKey) {
      continue
    }
    naturalAnchorByRepoId.set(repoId, cardEnd)
  }

  const anchorByRepoId = new Map(pinnedAnchorByRepoId)
  for (const [repoId, anchor] of naturalAnchorByRepoId) {
    anchorByRepoId.set(repoId, anchor)
  }
  if (pinnedHeaderIndex >= 0 && args.collapsedGroups.has(PINNED_GROUP_KEY)) {
    for (const worktree of args.pinnedSectionWorktrees) {
      const hostId = getWorktreeExecutionHostId(worktree, args.repoOf(worktree), defaultHostId)
      if (!anchorByRepoId.has(worktree.repoId) && isCandidateHost(worktree.repoId, hostId)) {
        anchorByRepoId.set(worktree.repoId, pinnedHeaderIndex)
      }
    }
  }
  if (anchorByRepoId.size === 0) {
    return rows
  }

  const linesAfterIndex = new Map<number, Row[]>()
  for (const [repoId, anchor] of anchorByRepoId) {
    const line = buildImportedWorktreesCardRow(
      importedWorktreesByRepo.get(repoId)!,
      'pinned-fallback',
      args.noticeHostContextLabelByRepoId?.get(repoId)
    )
    const lines = linesAfterIndex.get(anchor)
    if (lines) {
      lines.push(line)
    } else {
      linesAfterIndex.set(anchor, [line])
    }
  }
  const placed: Row[] = []
  for (let index = 0; index < rows.length; index++) {
    placed.push(rows[index]!)
    const lines = linesAfterIndex.get(index)
    if (lines) {
      placed.push(...lines)
    }
  }
  return placed
}
