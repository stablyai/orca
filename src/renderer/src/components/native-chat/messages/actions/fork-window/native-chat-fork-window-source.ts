import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import type { NativeChatForkRowAction } from '../use-native-chat-fork'

/** The chat a Fork window copies, and which of the window's choices its host can carry out. */
export type NativeChatForkWindowSource = {
  /** A chat session, or a terminal Claude chat read from its transcript. */
  kind: 'structured' | 'terminal'
  agent: TuiAgent
  /** The chat session's id, or the terminal chat's Claude session uuid. */
  sessionId: string
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
