import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatForkRowAction } from '../use-native-chat-fork'

/** The chat a Fork window copies, and which of the window's choices its host can carry out. */
export type NativeChatForkWindowSource = {
  /** A chat session, or a terminal chat read from its CLI's transcript. */
  kind: 'structured' | 'terminal'
  agent: TuiAgent
  /** The chat session's id, or a terminal Claude chat's session uuid; empty when there is none. */
  sessionId: string
  /** Its host cuts an exact copy that opens as the same kind (`request`). */
  cutsHere: boolean
  worktreeId: string
  target: RuntimeClientTarget
  /** The chat's tab title, as a subagent's report and a recap name it. */
  label: string
  /** The chat stopped at its agent's usage limit, so the window suggests another agent. */
  usageLimited: boolean
  subagentOffered: boolean
  newWorktreeOffered: boolean
  /** The exact copy can open in another workspace on this host. */
  destinationOffered: boolean
  messages: () => readonly NativeChatMessage[]
  /** The transcript entry an exact copy is cut through (a terminal chat's whole turn). */
  cutThrough: (throughItemId: string) => string
  request: NativeChatForkRowAction['request']
}
