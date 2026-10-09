import type {
  AgentChatPermissionMode,
  AgentSessionPermissionSeed
} from './agent-chat-permission-mode'
import type { AgentSessionOptionsResult, AgentSessionSubscribeEvent } from './agent-session-wire'
import type { GlobalSettings } from './global-settings-types'

type PermissionDefaultSettings = Pick<GlobalSettings, 'nativeChatPermissionMode'>

export type PermissionAcquisitionHost = {
  sessionId: string
  settings: () => GlobalSettings
  clientSettings: {
    get: () => PermissionDefaultSettings
    update: (updates: Partial<GlobalSettings>) => Promise<PermissionDefaultSettings>
  }
  updateSettings: (updates: Partial<GlobalSettings>) => void
  start: () => Promise<void>
  snapshot: () => Promise<Extract<AgentSessionSubscribeEvent, { type: 'snapshot' }>>
  fact: () => AgentSessionPermissionSeed
  readOptions: () => Promise<AgentSessionOptionsResult>
  /** Claude's initialize answer, withheld until called. */
  answerInitialize: () => void
  storedIntent: () => Promise<unknown>
  launchMode: () => AgentChatPermissionMode
  childPhase: () => string | undefined
  controls: () => unknown[]
  delivered: () => number
  send: () => Promise<void>
  close: () => Promise<void>
}

export type PermissionAcquisitionFixture = {
  permissionAcquisitionHost: (
    agent: 'claude' | 'codex',
    initial: AgentChatPermissionMode,
    newChat?: boolean
  ) => Promise<PermissionAcquisitionHost>
}
