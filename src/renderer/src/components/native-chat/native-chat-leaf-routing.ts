import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

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
    // Reject stale active ids after close/hydration so removed panes cannot inherit chat routing.
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
  // A stale active id can still name the removed sibling, so tab-wide evidence must wait for collapse.
  return !layout.activeLeafId || layout.activeLeafId === layout.root.leafId
}

/** Tab-wide evidence applies only to the original sole pane, never split siblings. */
export function nativeChatLeafOwnsTabWideEvidence(args: {
  ownerLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): boolean {
  const { ownerLeafId, leafId, leafIds } = args
  if (!ownerLeafId || !leafId) {
    return false
  }
  // A split makes original tab-wide evidence insufficient for any individual sibling.
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

export type NativeChatLeafRoute = {
  chatLeafId: string | null
  exitChat: boolean
}

export function resolveNativeChatLeafRoute(args: {
  isChatViewMode: boolean
  chatLeafId: string | null
  activeLeafId: string | null
  chatLeafStillMounted: boolean
  activeLeafIsEligible: boolean
  chatLeafHasConfirmedAgentExit?: boolean
}): NativeChatLeafRoute {
  const confirmedAgentExit = args.chatLeafHasConfirmedAgentExit
  if (!args.isChatViewMode) {
    return { chatLeafId: null, exitChat: false }
  }
  if (args.chatLeafId && args.chatLeafStillMounted && !confirmedAgentExit) {
    // Missing reconnect evidence is not an agent exit; retain chat while its owning pane remains mounted.
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  // Hydration may temporarily lack an active pane; preserve mode until a concrete owner exists.
  if (!args.activeLeafId && !confirmedAgentExit) {
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  if (args.chatLeafId && !args.chatLeafStillMounted && !confirmedAgentExit) {
    // Closing the owner is explicit; do not transfer chat to the newly active sibling.
    return { chatLeafId: null, exitChat: true }
  }
  if (args.activeLeafIsEligible && (!confirmedAgentExit || args.activeLeafId !== args.chatLeafId)) {
    return { chatLeafId: args.activeLeafId, exitChat: false }
  }
  // Return to terminal after owner removal or confirmed agent exit so the composer cannot target a shell.
  return { chatLeafId: null, exitChat: true }
}
