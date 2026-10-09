import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { GlobalSettings } from './global-settings-types'
import type { RuntimeMobileSessionTabsResult } from './runtime-types'
import type { AgentSessionStatusEvent, AgentSessionSubscribeEvent } from './agent-session-wire'

export type ChatPermissionCreationHost = {
  settings: () => GlobalSettings
  /** Provider processes started so far, Claude and Codex together. */
  starts: () => number
  /** With `heldStart`, answers the providers' held start. */
  releaseStart: () => void
  /** The snapshot a client subscribing to the chat now opens with. */
  snapshot: (sessionId: string) => Promise<AgentSessionSubscribeEvent>
  rpc: (method: string, params: unknown) => Promise<unknown>
  inventory: () => Promise<RuntimeMobileSessionTabsResult[]>
  subscribeStatus: (
    emit: (event: AgentSessionStatusEvent) => void
  ) => Promise<{ unsubscribe: () => void }>
  savedSetting: () => Promise<unknown>
  savedMode: (sessionId: string) => Promise<string | undefined>
  close: () => Promise<void>
}

export type ChatPermissionCreationFixture = {
  openChatPermissionCreationHost: (
    initial: AgentChatPermissionMode,
    options?: { withoutAuto?: boolean; heldStart?: boolean }
  ) => Promise<ChatPermissionCreationHost>
}
