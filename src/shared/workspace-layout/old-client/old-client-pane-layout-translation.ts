// Translate an older desktop’s whole pane tree to commands against owner order. Refuse structures no single command reaches while retaining title/chat updates.

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
  /** Refused pane changes/multiple moves produce updated:false; metadata commands still apply. */
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
  // Title maps replace rather than merge; omitted pane entries clear their titles.
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
  // Preserve legacy null-tree no-op semantics.
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

/** Find one move ignoring ratios. Only two-leaf target splits qualify, keeping the search linear in untrusted trees of up to 1024 nodes. */
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
