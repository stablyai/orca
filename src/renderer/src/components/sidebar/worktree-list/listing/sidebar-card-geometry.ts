import type { WorktreeCardProperty } from '../../../../../../shared/ui-chrome-types'
import {
  hasWorktreeLineageChildChip,
  selectWorktreeCardDisplayMode,
  selectWorktreeCardIdentity,
  selectWorktreeCardLayout
} from '../../worktree-card-layout'
import { isPinnedWorktreeRow, type WorktreeItemRow } from './renderable-rows'

export type SidebarCardDimensions = {
  fingerprint: string
  own: number
  prefix: number
  closing: number
}
export type SidebarCardGeometryResolver = (
  row: WorktreeItemRow,
  expanded: boolean
) => SidebarCardDimensions | null
export type SidebarCardGeometryInputs = {
  newCardStyle: boolean
  compactPreference: boolean
  cardProps: readonly WorktreeCardProperty[]
  hasProjectGroups: boolean
  hideRepoBadge: boolean
  agentCandidateIds: ReadonlySet<string>
  blockedIds: ReadonlySet<string>
}

export function resolveSidebarCardGeometry(
  row: WorktreeItemRow,
  expanded: boolean,
  inputs: SidebarCardGeometryInputs
): SidebarCardDimensions | null {
  if (
    inputs.agentCandidateIds.has(row.worktree.id) ||
    inputs.blockedIds.has(row.worktree.id) ||
    row.repo?.connectionId
  ) {
    return null
  }
  const display = selectWorktreeCardDisplayMode(
    inputs.newCardStyle,
    inputs.compactPreference,
    inputs.cardProps
  )
  const identity = selectWorktreeCardIdentity({
    worktree: row.worktree,
    repo: row.repo,
    newCardStyle: inputs.newCardStyle,
    cardProps: inputs.cardProps,
    hasProjectGroups: inputs.hasProjectGroups
  })
  if (
    !display.showInlineAgentList ||
    display.compactCards ||
    identity.isFolder ||
    identity.detachedHeadDisplay ||
    row.hostContextLabel
  ) {
    return null
  }
  const showLineageChildChip = hasWorktreeLineageChildChip(
    row.lineageChildCount,
    !!row.lineageGroupKey
  )
  if (expanded && !showLineageChildChip) {
    return null
  }
  const layout = selectWorktreeCardLayout({
    newCardStyle: inputs.newCardStyle,
    compactCards: display.compactCards,
    hasRepo: !!row.repo,
    inPinnedSection: isPinnedWorktreeRow(row),
    hideRepoBadge: inputs.hideRepoBadge,
    ...identity,
    detachedHead: false,
    displayName: row.worktree.displayName,
    conflictOperation: null,
    cacheVisible: false,
    hasDetails: false,
    hasPorts: false,
    showInlineAgentList: display.showInlineAgentList,
    showLineageChildChip,
    hasRemoteBranchConflict: false
  })
  // Detail/port icons fit the existing 20px header or 16px repo-pill lane without wrapping.
  if ((!inputs.newCardStyle && !layout.showRepoBadgeInMetaRow) || layout.titleOnlyCard) {
    return null
  }
  const metadataHeight = layout.showRepoBadgeInMetaRow
    ? 16
    : identity.showIdentityInNewCard
      ? 11
      : 0
  const own =
    2 + 11 + 20 + (metadataHeight ? 6 + metadataHeight : 0) + (showLineageChildChip ? 28 : 0)
  const closing = 7
  return {
    fingerprint: `card-v1:${inputs.newCardStyle ? 'new' : 'legacy'}:${metadataHeight}:${showLineageChildChip}:${expanded}`,
    own,
    prefix: own - closing + 6 + (inputs.newCardStyle ? 0 : 6),
    closing
  }
}
