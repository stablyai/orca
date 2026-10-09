import type {
  AgentChatPermissionMode,
  AgentSessionPermissionSeed
} from './agent-chat-permission-mode'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from './agent-session-wire'

export type PermissionRestartHost = {
  sessionId: string
  pick: (
    value: string,
    envelope?: AgentSessionMutationEnvelope
  ) => Promise<AgentSessionMutationResult<AgentSessionOptionResult>>
  fact: () => AgentSessionPermissionSeed & { revision: number }
  readOptions: () => Promise<AgentSessionOptionsResult>
  restart: () => Promise<void>
  close: () => Promise<void>
}

export type PermissionRestartFixture = {
  permissionRestartHost: (
    agent: 'claude' | 'codex',
    retained: AgentChatPermissionMode
  ) => Promise<PermissionRestartHost>
}
