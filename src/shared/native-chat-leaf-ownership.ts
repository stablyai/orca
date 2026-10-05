import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from './terminal-tab-types'
import type { TuiAgent } from './tui-agent'

export function terminalLayoutNodeContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return (
    terminalLayoutNodeContainsLeaf(node.first, leafId) ||
    terminalLayoutNodeContainsLeaf(node.second, leafId)
  )
}

/** The tree's leaf ids in tree order (first before second). */
export function terminalLayoutNodeLeafIds(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.leafId]
    : [...terminalLayoutNodeLeafIds(node.first), ...terminalLayoutNodeLeafIds(node.second)]
}

export function resolveNativeChatActiveLayoutLeafId(
  layout: TerminalLayoutSnapshot | null | undefined
): string | null {
  if (!layout) {
    return null
  }
  if (layout.activeLeafId) {
    // Why: close/hydration races can leave activeLeafId one snapshot behind
    // the topology; stale pane evidence must not route chat to a removed leaf.
    return !layout.root || terminalLayoutNodeContainsLeaf(layout.root, layout.activeLeafId)
      ? layout.activeLeafId
      : null
  }
  return layout.root?.type === 'leaf' ? layout.root.leafId : null
}

export function isNativeChatTabWideFallbackSafe(
  layout: TerminalLayoutSnapshot | null | undefined
): boolean {
  if (!layout?.root) {
    return true
  }
  if (layout.root.type === 'split') {
    return false
  }
  // Why: a stale active id means the single-leaf collapse is not yet settled;
  // tab-wide launch/title evidence could still describe the removed sibling.
  return !layout.activeLeafId || layout.activeLeafId === layout.root.leafId
}

/** Whether tab-wide launch evidence (agent hint, launch draft) describes this
 *  leaf: it must still be the tab's sole pane and the one the evidence bound to. */
export function nativeChatLeafOwnsTabWideEvidence(args: {
  ownerLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): boolean {
  const { ownerLeafId, leafId, leafIds } = args
  if (!ownerLeafId || !leafId) {
    return false
  }
  // Why: the evidence belongs to the tab's original pane. Once a split exists,
  // it says nothing about any particular sibling.
  return leafIds.length === 1 && leafIds[0] === leafId && ownerLeafId === leafId
}

export function nativeChatLaunchAgentForLeaf(args: {
  launchAgent?: TuiAgent | null
  launchAgentLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): TuiAgent | null {
  const { launchAgent, launchAgentLeafId, leafId, leafIds } = args
  if (!launchAgent) {
    return null
  }
  return nativeChatLeafOwnsTabWideEvidence({
    ownerLeafId: launchAgentLeafId,
    leafId,
    leafIds
  })
    ? launchAgent
    : null
}
