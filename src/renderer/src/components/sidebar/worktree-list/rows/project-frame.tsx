import React, { useMemo } from 'react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { isProjectTreeOn } from '../../../../../../shared/sidebar-list/project-tree-settings'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import { PROJECT_GROUP_HEADER_INDENT } from './indentation'
import { shouldUseHeaderTopSpacing } from '../viewport/virtual-rows'

type Edge = 'top' | 'middle' | 'bottom' | 'single'

/** One row's share of the Tree card style's chrome: its card and the panels of the open groups around it. */
export type ProjectFramePiece = {
  /** A project's card, or a folder group's own chats card. */
  card?: { edge: Edge; depth: number; current: boolean }
  /** Depths of the open project groups this row sits in. */
  guides: readonly number[]
  /** The open groups whose panel this row carries a slice of. */
  panels?: readonly { depth: number; edge: Exclude<Edge, 'single'> }[]
  /** A top-level group or project after another: extra room above it. */
  separated?: boolean
}

/** The height a separated header adds (its top padding grows from 4px to 12px). */
export const TREE_SEPARATOR_SPACE = 8

/** A top-level group or project with something above it in its host section. */
export function isSeparatedTreeHeader(
  rows: readonly HostSectionRow[],
  index: number,
  firstHeaderIndex: number
): boolean {
  const row = rows[index]
  return (
    row?.type === 'header' &&
    (row.projectGroupDepth ?? 0) === 0 &&
    rows[index - 1]?.type !== 'host-header' &&
    // The extra room extends the header's own top spacing, so both follow one rule.
    shouldUseHeaderTopSpacing({ rows, index, firstHeaderIndex })
  )
}

/** A Tree workspace or session row is one line: its height before the 6px gap it carries. */
export const TREE_LINE_ROW_HEIGHT = 24

function closesGroup(row: HostSectionRow, depth: number): boolean {
  return (
    row.type === 'host-header' || (row.type === 'header' && (row.projectGroupDepth ?? 0) <= depth)
  )
}

/** An open group is a panel over all its rows; inside it, each project and a folder group's chats are cards. */
export function computeProjectFrames(
  rows: readonly HostSectionRow[],
  activeRepoId: string | null
): ReadonlyMap<number, ProjectFramePiece> {
  const pieces = new Map<number, ProjectFramePiece>()
  const firstHeaderIndex = rows.findIndex(
    (row) => row.type === 'header' || row.type === 'host-header'
  )
  let openGroups: number[] = []
  let card: { start: number; depth: number; current: boolean } | null = null
  const cardRows: { index: number; start: number }[] = []
  rows.forEach((row, index) => {
    if (row.type === 'host-header') {
      openGroups = []
      card = null
      return
    }
    if (row.type === 'header') {
      card = null
      const depth = row.projectGroupDepth ?? 0
      openGroups = openGroups.filter((open) => open < depth)
      pieces.set(index, {
        guides: openGroups,
        separated: isSeparatedTreeHeader(rows, index, firstHeaderIndex)
      })
      if (row.repo) {
        card = { start: index, depth, current: row.repo.id === activeRepoId }
      } else if (row.projectGroup) {
        openGroups = [...openGroups, depth]
      }
    } else {
      pieces.set(index, { guides: openGroups })
      if (row.type === 'project-chats' && row.section === 'group-chats') {
        card = { start: index, depth: row.groupDepth + 1, current: false }
      }
    }
    if (card) {
      cardRows.push({ index, start: card.start })
      pieces.set(index, {
        ...pieces.get(index)!,
        card: { edge: 'middle', depth: card.depth, current: card.current }
      })
    }
  })
  cardRows.forEach(({ index, start }, at) => {
    const opens = index === start
    const closes = cardRows[at + 1]?.start !== start
    const piece = pieces.get(index)!
    const edge = opens && closes ? 'single' : opens ? 'top' : closes ? 'bottom' : 'middle'
    pieces.set(index, { ...piece, card: { ...piece.card!, edge } })
  })
  rows.forEach((row, start) => {
    if (row.type !== 'header' || row.repo || !row.projectGroup) {
      return
    }
    const depth = row.projectGroupDepth ?? 0
    let end = start
    while (end + 1 < rows.length && !closesGroup(rows[end + 1], depth)) {
      end += 1
    }
    // A collapsed group is its header alone and stays a plain label.
    for (let index = start; end > start && index <= end; index += 1) {
      const piece = pieces.get(index)!
      const edge = index === start ? 'top' : index === end ? 'bottom' : 'middle'
      pieces.set(index, { ...piece, panels: [...(piece.panels ?? []), { depth, edge }] })
    }
  })
  return pieces
}

export function useProjectFrames(
  rows: readonly HostSectionRow[],
  activeWorktreeId: string | null
): ReadonlyMap<number, ProjectFramePiece> | undefined {
  const enabled = useAppStore((s) => isProjectTreeOn(s.settings))
  const activeRepoId = activeWorktreeId ? getRepoIdFromWorktreeId(activeWorktreeId) : null
  return useMemo(
    () => (enabled ? computeProjectFrames(rows, activeRepoId) : undefined),
    [enabled, rows, activeRepoId]
  )
}

// Each depth steps a card 10px in on the left, with the header indent, and 6px in on the right.
const cardLeft = (depth: number): number => 4 + depth * PROJECT_GROUP_HEADER_INDENT
const cardRight = (depth: number): number => 4 + depth * 6

/** A card's (or a group panel's) edges, in px in from the row's sides; a header's own highlight keeps to them. */
export function getTreeCardInset(depth: number): { left: number; right: number } {
  return { left: cardLeft(depth), right: cardRight(depth) }
}

/**
 * Where a Tree row sits, in px from the row's left edge: its highlight spans `surface` to
 * `right` from the far edge, and its leading glyph or label starts at `glyph`. Rows in a card
 * keep 4px inside it; any other row of a group lines up with the cards in that group.
 */
export function getTreeLane(
  kind: 'card' | 'group',
  depth: number
): { surface: number; right: number; glyph: number } {
  const cardDepth = kind === 'card' ? depth : depth + 1
  const inset = kind === 'card' ? 4 : 0
  const surface = cardLeft(cardDepth) + inset
  return { surface, right: cardRight(cardDepth) + inset, glyph: surface + 10 }
}

/** The lane of a worktree or session row, from its piece of the frame; null outside the tree. */
export function getTreeRowLane(
  piece: ProjectFramePiece | undefined
): ReturnType<typeof getTreeLane> | null {
  if (piece?.card) {
    return getTreeLane('card', piece.card.depth)
  }
  const group = piece?.guides.at(-1)
  return group === undefined ? null : getTreeLane('group', group)
}

export function ProjectFrameEdge({
  piece,
  gapInside = false
}: {
  piece: ProjectFramePiece | undefined
  /** Workspace rows carry the 6px gap in their own height; bridging it again would overlap the next row. */
  gapInside?: boolean
}): React.JSX.Element | null {
  if (!piece) {
    return null
  }
  const card = piece.card
  const opens = card?.edge === 'top' || card?.edge === 'single'
  const closes = card?.edge === 'bottom' || card?.edge === 'single'
  // Rows sit 6px apart: a slice reaches across the gap below it unless the row already holds it.
  const bridge = gapInside ? 'bottom-0' : '-bottom-1.5'
  return (
    <>
      {piece.panels?.map(({ depth, edge }) => (
        <div
          key={depth}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 -z-10 bg-worktree-sidebar-accent',
            edge === 'top' && 'rounded-t-xl',
            edge === 'top' && (piece.separated ? 'top-2' : 'top-0'),
            edge === 'bottom' && 'rounded-b-xl',
            bridge
          )}
          style={getTreeCardInset(depth)}
        />
      ))}
      {card ? (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 -z-10 border-x border-border bg-card',
            opens && 'rounded-t-lg border-t',
            opens && (piece.separated ? 'top-2.5' : 'top-0.5'),
            closes && 'rounded-b-lg border-b',
            // A workspace row ending a card keeps its gap below the card.
            closes ? (gapInside ? 'bottom-1' : 'bottom-0') : bridge,
            card.current && 'border-primary/40'
          )}
          style={getTreeCardInset(card.depth)}
        />
      ) : null}
    </>
  )
}
