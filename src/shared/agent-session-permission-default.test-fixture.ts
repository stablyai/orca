import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import type { PermissionRestartHost } from './agent-session-permission-restart.test-fixture'

export type PermissionDefaultHost = PermissionRestartHost & {
  frames: AgentSessionSubscribeEvent[]
  changeDefault: (mode: AgentChatPermissionMode) => void
  publish: () => Promise<void>
  snapshot: () => Promise<AgentSessionSubscribeEvent>
  storedIntent: () => Promise<unknown>
  permitWrites: () => void
}
export type PermissionDefaultFixture = {
  permissionDefaultHost: (
    agent: 'claude' | 'codex',
    initial: AgentChatPermissionMode,
    savedOptions?: Record<string, string>
  ) => Promise<PermissionDefaultHost>
}
