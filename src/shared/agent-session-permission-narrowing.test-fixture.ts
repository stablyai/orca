import type { AgentSessionPermissionSeed } from './agent-chat-permission-mode'
import type { AgentSessionOptionsResult, AgentSessionSubscribeEvent } from './agent-session-wire'

export type PermissionNarrowingScenario = 'codex-start' | 'claude-start' | 'claude-model'

export type PermissionNarrowingHost = {
  sessionId: string
  agent: 'claude' | 'codex'
  frames: AgentSessionSubscribeEvent[]
  fact: () => AgentSessionPermissionSeed & { revision: number }
  start: () => Promise<void>
  switchModel: () => Promise<void>
  readOptions: () => Promise<AgentSessionOptionsResult>
  storedIntent: () => Promise<{
    options?: Readonly<Record<string, string>>
    permissionRevision?: number
  }>
  close: () => Promise<void>
}

export type PermissionNarrowingFixture = {
  permissionNarrowingHost: (
    scenario: PermissionNarrowingScenario
  ) => Promise<PermissionNarrowingHost>
}
