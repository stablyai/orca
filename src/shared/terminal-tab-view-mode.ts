import {
  terminalLayoutNodeContainsLeaf,
  terminalLayoutNodeLeafIds
} from './native-chat-leaf-ownership'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'

export type TerminalTabViewMode = 'terminal' | 'chat'

/** A terminal tab's chat/terminal choice: the mode plus the leaf that owns chat. */
export type TerminalChatPair = {
  viewMode?: TerminalTabViewMode
  chatLeafId?: string
}

/** The one read of a tab's view: desktop renders the unified tab, host sync writes the row. */
export function resolveTerminalTabViewMode(
  unified: { viewMode?: TerminalTabViewMode } | null | undefined,
  row: { viewMode?: TerminalTabViewMode } | null | undefined
): TerminalTabViewMode | undefined {
  return unified?.viewMode ?? row?.viewMode
}

/**
 * The absolute pair a `viewMode` write produces. `leafId` is the addressed leaf, or null when
 * the write named the parent tab. Returns null when the addressed leaf is not in the tree, or when
 * a host's `pickOwner` finds no pane of a split that may own a parent-addressed chat.
 */
export function resolveTerminalChatPairWrite(args: {
  current: TerminalChatPair
  root: TerminalPaneLayoutNode | null | undefined
  viewMode: TerminalTabViewMode
  leafId: string | null
  /** Hosts only: the owner for a parent-addressed chat with no valid owner. */
  pickOwner?: () => string | null
}): TerminalChatPair | null {
  const { current, root, viewMode, leafId, pickOwner } = args
  if (leafId !== null && !terminalLayoutNodeContainsLeaf(root, leafId)) {
    return null
  }
  if (viewMode === 'terminal') {
    return { viewMode: 'terminal' }
  }
  if (leafId !== null) {
    return { viewMode: 'chat', chatLeafId: leafId }
  }
  // Why: older paired clients address the parent; keep a valid owner rather than guessing one.
  // A terminal tab's leftover owner (saved before owners cleared on exit) is not kept.
  const owner =
    current.viewMode !== 'terminal' &&
    current.chatLeafId &&
    terminalLayoutNodeContainsLeaf(root, current.chatLeafId)
      ? current.chatLeafId
      : undefined
  if (owner) {
    return { viewMode: 'chat', chatLeafId: owner }
  }
  if (!pickOwner) {
    return { viewMode: 'chat' }
  }
  const picked = pickOwner()
  if (picked && terminalLayoutNodeContainsLeaf(root, picked)) {
    return { viewMode: 'chat', chatLeafId: picked }
  }
  // Why: only a split can put chat on the wrong pane; a tree with no pane yet takes the write.
  return terminalLayoutNodeLeafIds(root).length < 2 ? { viewMode: 'chat' } : null
}

/**
 * The owner a tab stores after its tree grows. A chat that never got an owner was unambiguous on
 * its single pane, so that pane keeps it before a new pane exists. A stored owner is never moved,
 * not even an invalid one: that still reads as terminal.
 */
export function pinTerminalChatOwnerOnGrowth(args: {
  viewMode: TerminalTabViewMode | undefined
  chatLeafId: string | undefined
  priorRoot: TerminalPaneLayoutNode | null | undefined
  nextRoot: TerminalPaneLayoutNode | null | undefined
}): string | undefined {
  const { viewMode, chatLeafId, priorRoot, nextRoot } = args
  if (chatLeafId || viewMode !== 'chat' || priorRoot?.type !== 'leaf') {
    return chatLeafId
  }
  return nextRoot?.type === 'split' && terminalLayoutNodeContainsLeaf(nextRoot, priorRoot.leafId)
    ? priorRoot.leafId
    : undefined
}

/**
 * Normalizes a pair for readers: an owner that is present but not in the tree means the owning
 * pane was removed, so the tab is terminal and no sibling may claim chat.
 */
export function normalizeTerminalChatPair(
  pair: TerminalChatPair,
  root: TerminalPaneLayoutNode | null | undefined
): TerminalChatPair {
  // Why: a tree that is not known yet cannot prove the owner gone.
  if (!pair.chatLeafId || !root || terminalLayoutNodeContainsLeaf(root, pair.chatLeafId)) {
    return pair
  }
  return pair.viewMode ? { viewMode: pair.viewMode === 'chat' ? 'terminal' : pair.viewMode } : {}
}
