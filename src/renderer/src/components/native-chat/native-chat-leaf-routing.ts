import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TuiAgent
} from '../../../../shared/types'

function layoutNodeContainsLeaf(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutNodeContainsLeaf(node.first, leafId) || layoutNodeContainsLeaf(node.second, leafId)
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
    return !layout.root || layoutNodeContainsLeaf(layout.root, layout.activeLeafId)
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

export function nativeChatLaunchAgentForLeaf(args: {
  launchAgent?: TuiAgent | null
  launchAgentLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): TuiAgent | null {
  const { launchAgent, launchAgentLeafId, leafId, leafIds } = args
  if (!launchAgent || !launchAgentLeafId || !leafId) {
    return null
  }
  // Why: launchAgent belongs to the tab's original pane. Once a split exists,
  // it is not evidence that an agent is running in any particular sibling.
  return leafIds.length === 1 && leafIds[0] === leafId && launchAgentLeafId === leafId
    ? launchAgent
    : null
}

export type NativeChatLeafRoute = {
  chatLeafId: string | null
  exitChat: boolean
}

export function resolveNativeChatLeafRoute(args: {
  isChatViewMode: boolean
  chatLeafId: string | null
  activeLeafId: string | null
  chatLeafStillMounted: boolean
  chatLeafIsEligible: boolean
  activeLeafIsEligible: boolean
}): NativeChatLeafRoute {
  if (!args.isChatViewMode) {
    return { chatLeafId: null, exitChat: false }
  }
  if (args.chatLeafId && args.chatLeafStillMounted && args.chatLeafIsEligible) {
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  // Manager hydration can briefly have no active pane; preserve the requested
  // mode until a concrete leaf exists instead of toggling it off during mount.
  if (!args.activeLeafId) {
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  if (args.activeLeafIsEligible) {
    return { chatLeafId: args.activeLeafId, exitChat: false }
  }
  // Why: closing or invalidating the chat-owning leaf must not move its composer
  // onto a plain-shell sibling. Return the tab to terminal mode instead.
  return { chatLeafId: null, exitChat: true }
}
