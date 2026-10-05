export {
  isNativeChatTabWideFallbackSafe,
  nativeChatLaunchAgentForLeaf,
  nativeChatLeafOwnsTabWideEvidence,
  resolveNativeChatActiveLayoutLeafId
} from '../../../../shared/native-chat-leaf-ownership'

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
    // Why: agent/title evidence can disappear while local, SSH, or runtime
    // transports reconnect. A mounted owning pane is not a terminal lifecycle
    // event, so keep its chat surface until the pane itself is removed.
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  // Manager hydration can briefly have no active pane; preserve the requested
  // mode until a concrete leaf exists instead of toggling it off during mount.
  if (!args.activeLeafId && !confirmedAgentExit) {
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  if (args.chatLeafId && !args.chatLeafStillMounted && !confirmedAgentExit) {
    // A user-closed chat pane is an explicit close, not an agent handoff. Do not
    // retarget the chat surface to whichever sibling became active.
    return { chatLeafId: null, exitChat: true }
  }
  if (args.activeLeafIsEligible && (!confirmedAgentExit || args.activeLeafId !== args.chatLeafId)) {
    return { chatLeafId: args.activeLeafId, exitChat: false }
  }
  // Why: removing the owning leaf or confirming its agent exited must not leave
  // the composer targeting a plain shell. Return the tab to terminal mode.
  return { chatLeafId: null, exitChat: true }
}
