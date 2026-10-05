import { terminalLayoutNodeContainsLeaf } from './native-chat-leaf-ownership'
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
 * the write named the parent tab. Returns null when the addressed leaf is not in the tree.
 */
export function resolveTerminalChatPairWrite(args: {
  current: TerminalChatPair
  root: TerminalPaneLayoutNode | null | undefined
  viewMode: TerminalTabViewMode
  leafId: string | null
}): TerminalChatPair | null {
  const { current, root, viewMode, leafId } = args
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
  return owner ? { viewMode: 'chat', chatLeafId: owner } : { viewMode: 'chat' }
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
