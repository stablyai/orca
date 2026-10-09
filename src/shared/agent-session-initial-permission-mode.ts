import {
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import {
  isAgentSessionPermissionOrder,
  type AgentSessionPermissionOrder
} from './agent-session-permission-order'

export type AgentSessionInitialPermissionMode = {
  /** The mode this chat was created to start in: its host's new-chat seed for the agent (so Ask
   *  for a Codex chat created under Accept edits). Narrowing and the user's picks change the
   *  chat's mode, never this. Absent from older records. */
  initialPermissionMode?: AgentChatPermissionMode
}

export function isAgentSessionInitialPermissionMode(value: {
  initialPermissionMode?: unknown
}): value is AgentSessionInitialPermissionMode {
  return (
    value.initialPermissionMode === undefined ||
    isAgentChatPermissionMode(value.initialPermissionMode)
  )
}

/** What a status summary says of a chat's permissions, both absent from older hosts. Together
 *  they decide whether an empty chat can stand in for a new one. */
export type AgentSessionStatusPermissionModes = AgentSessionInitialPermissionMode & {
  /** The chat's saved mode now; also absent for agents without chat permissions. */
  permissionMode?: AgentChatPermissionMode
}

/** The permission facts a chat record keeps beside its options. */
export type AgentSessionRecordPermissionFacts = AgentSessionPermissionOrder &
  AgentSessionInitialPermissionMode

export function isAgentSessionRecordPermissionFacts(value: {
  permissionRevision?: unknown
  initialPermissionMode?: unknown
}): value is AgentSessionRecordPermissionFacts {
  const { permissionRevision, initialPermissionMode } = value
  return (
    isAgentSessionPermissionOrder({ permissionRevision }) &&
    isAgentSessionInitialPermissionMode({ initialPermissionMode })
  )
}
