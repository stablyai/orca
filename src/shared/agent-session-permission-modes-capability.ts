// Split out of protocol-version.ts; listed in AGENT_SESSION_RUNTIME_CAPABILITIES. Import it from here.

// Why: a host predating per-chat modes ignores them and runs its Agent Permissions, so a client
// must know before it lets a chat there start or take a turn. 1.4.225–1.4.226 apply modes without
// advertising this; they are recognised by the `nativeChatPermissionMode` their settings carry.
export const AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY =
  'agent-session.permission-modes.v1' as const
