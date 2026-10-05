import { isNativeChatSupportedAgent } from './native-chat-agent-support'

// Why 1 s: per write chunk, well inside a composer action's 15 s send budget.
export const NATIVE_CHAT_TARGET_READ_RELAY_TIMEOUT_MS = 1_000

/** What the host's committed tab state says about a composer write aimed at one PTY. */
export type NativeChatTargetRead =
  /** The PTY's pane may render chat: the write is aimed at the agent the user sees. */
  | { kind: 'chat-target'; presentationToken: string }
  /** The PTY's tab is known but its presentation no longer permits chat there. */
  | { kind: 'not-chat-target' }
  /** No committed tab binds this PTY: a targeting failure, no bytes. */
  | { kind: 'unknown-target' }

export type NativeChatTargetReadRequest = { requestId: string; ptyId: string }
export type NativeChatTargetReadResponse = { requestId: string; read?: NativeChatTargetRead }

/**
 * The one structural rule for "this pane may show chat", shared by exit discovery and composer
 * admission: an explicit chat owned by this pane (a sole pane may own an ownerless chat), or an
 * unswitched sole pane whose launch hint is a native-chat agent (the phone's default). A retired
 * hint, explicit terminal, a sibling, or a multi-pane unswitched tab do not qualify.
 */
export function isComposerChatTarget(args: {
  viewMode: 'terminal' | 'chat' | undefined
  chatLeafId: string | undefined
  launchAgent: string | undefined
  leafIds: readonly string[]
  leafId: string
}): boolean {
  const soleLeaf = args.leafIds.length <= 1
  if (args.leafIds.length > 0 && !args.leafIds.includes(args.leafId)) {
    return false
  }
  if (args.viewMode === 'chat') {
    const owner =
      args.chatLeafId && args.leafIds.includes(args.chatLeafId) ? args.chatLeafId : undefined
    return owner ? owner === args.leafId : soleLeaf
  }
  return args.viewMode === undefined && soleLeaf && isNativeChatSupportedAgent(args.launchAgent)
}
