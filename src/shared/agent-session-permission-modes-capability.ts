// Probe per-chat modes before start/send: older hosts ignore them and use Agent Permissions. Versions 1.4.225–1.4.226 apply unadvertised modes; recognize nativeChatPermissionMode in their settings.
export const AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY =
  'agent-session.permission-modes.v1' as const

// Host accepts own chat intent and reports the permission the agent selected.
export const AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY =
  'agent-session.permission-own.v1' as const
