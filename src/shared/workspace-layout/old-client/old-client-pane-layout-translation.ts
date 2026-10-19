// `session.tabs.updatePaneLayout` from older desktops (design 2.6, rule 11): the whole pane tree
// they send becomes the commands that reach it, compared with the current tree in the owner's
// order. A structure no single command reaches is refused; titles and the chat pane still apply.

import type { TerminalPaneLayoutNode } from '../../terminal-tab-types'
import {
  collectLayoutLeafIdsInOrder,
  insertLeafBeside,
  removeLayoutLeaf,
  samePanesIgnoringRatios,
  type PaneSide
} from '../terminal-pane-tree'
import type { LayoutCommand } from '../workspace-layout-command-types'
import type { LayoutTerminalTab, WorkspaceLayout } from '../workspace-layout-model'

export type PaneLayoutTranslation = {
  /** In apply order; the runtime applies them as one change, so one update is published. */
  commands: LayoutCommand[]
  /** The sent tree changes panes or moves more than one; new: the handler replies `{updated: false}` (today it always replies true). */
  structureRefused: boolean
}

/** The parsed `UpdatePaneLayout` params this translation reads. */
export type SentPaneLayout = {
  root: TerminalPaneLayoutNode | null
  chatLeafId?: string | null
  titlesByLeafId?: Record<string, string>
}

/** `expandedLeafId` is view state, so it is not read. */
export function translateUpdatePaneLayout(
  workspaceKey: string,
  workspace: WorkspaceLayout,
  tab: LayoutTerminalTab,
  sent: SentPaneLayout
): PaneLayoutTranslation {
  const on = { workspace: workspaceKey, tabId: tab.id }
  const current = tab.panes.root
  const leafIds = collectLayoutLeafIdsInOrder(current)
  const commands: LayoutCommand[] = []
  // Today a sent title map replaces the stored one, so a pane missing from it loses its title.
  if (sent.titlesByLeafId) {
    for (const leafId of leafIds) {
      const title = sent.titlesByLeafId[leafId] ?? null
      if (title !== (workspace.leaves?.[leafId]?.title ?? null)) {
        commands.push({ ...on, type: 'renamePane', leafId, title })
      }
    }
  }
  // Absent leaves the chat pane alone; null clears it.
  if (sent.chatLeafId !== undefined) {
    const chatLeafId = sent.chatLeafId
    if (
      chatLeafId !== (tab.panes.chatLeafId ?? null) &&
      (chatLeafId === null || leafIds.includes(chatLeafId))
    ) {
      commands.push({ ...on, type: 'setChatPane', leafId: chatLeafId })
    }
  }
  // A null tree leaves the panes alone, as today.
  if (!sent.root || !current) {
    return { commands, structureRefused: false }
  }
  if (samePanesIgnoringRatios(current, sent.root)) {
    if (!sameRatios(current, sent.root)) {
      commands.push({ ...on, type: 'setPaneRatios', root: sent.root })
    }
    return { commands, structureRefused: false }
  }
  const move = findSinglePaneMove(current, sent.root)
  if (!move) {
    return { commands, structureRefused: true }
  }
  commands.push({ ...on, type: 'movePane', ...move })
  const moved = insertLeafBeside(
    removeLayoutLeaf(current, move.leafId)!,
    move.targetLeafId,
    move.leafId,
    move.side
  )
  if (!sameRatios(moved, sent.root)) {
    commands.push({ ...on, type: 'setPaneRatios', root: sent.root })
  }
  return { commands, structureRefused: false }
}

type PaneMove = { leafId: string; targetLeafId: string; side: PaneSide }

/**
 * The one pane move that turns `current` into `sent`, ignoring ratios. A moved pane always ends in
 * a split with its target pane, so only splits of two panes in `sent` are candidates: linear in
 * the tree, which matters because the tree is untrusted input of up to 1024 nodes.
 */
function findSinglePaneMove(
  current: TerminalPaneLayoutNode,
  sent: TerminalPaneLayoutNode
): PaneMove | null {
  const currentIds = collectLayoutLeafIdsInOrder(current).sort()
  const sentIds = collectLayoutLeafIdsInOrder(sent).sort()
  if (
    currentIds.length !== sentIds.length ||
    currentIds.some((leafId, index) => leafId !== sentIds[index]) ||
    new Set(sentIds).size !== sentIds.length
  ) {
    return null
  }
  for (const move of candidateMoves(sent)) {
    const without = removeLayoutLeaf(current, move.leafId)
    if (
      without &&
      samePanesIgnoringRatios(
        insertLeafBeside(without, move.targetLeafId, move.leafId, move.side),
        sent
      )
    ) {
      return move
    }
  }
  return null
}

function candidateMoves(node: TerminalPaneLayoutNode): PaneMove[] {
  const moves: PaneMove[] = []
  const stack = [node]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (next.type === 'leaf') {
      continue
    }
    const { first, second } = next
    if (first.type === 'leaf' && second.type === 'leaf') {
      const vertical = next.direction === 'vertical'
      moves.push(
        { leafId: first.leafId, targetLeafId: second.leafId, side: vertical ? 'left' : 'top' },
        { leafId: second.leafId, targetLeafId: first.leafId, side: vertical ? 'right' : 'bottom' }
      )
    }
    stack.push(first, second)
  }
  return moves
}

/** Both trees have the same shape; whether every divider sits at the same ratio. */
function sameRatios(left: TerminalPaneLayoutNode, right: TerminalPaneLayoutNode): boolean {
  if (left.type === 'leaf' || right.type === 'leaf') {
    return true
  }
  return (
    left.ratio === right.ratio &&
    sameRatios(left.first, right.first) &&
    sameRatios(left.second, right.second)
  )
}
