import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session/agent-session-runtime-capabilities'

/**
 * CLOUD-HELD-SURFACE: what every Orca Cloud image we ship advertises for structured chats. The
 * composer decides a create's chat-or-terminal route before the VM exists, so with chat preferred
 * an Orca Cloud create opens a chat (held on its strip until the agent can run). A VM that refuses
 * the chat after all (an older image) falls back to its held terminal.
 */
export const ORCA_CLOUD_PENDING_HOST_CAPABILITIES: readonly string[] = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
]
