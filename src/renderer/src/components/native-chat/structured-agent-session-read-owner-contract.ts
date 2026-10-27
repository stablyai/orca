import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

export type StructuredAgentSessionReadSnapshot = {
  state: StructuredAgentSessionState
  loadingOlder: boolean
  /** Bumped whenever older-page reads are invalidated (open, snapshot, reset, dispose). */
  olderHistoryGeneration: number
  providerSession?: AgentProviderSessionMetadata
  /** False from lost contact/read stop until state catches up to the host’s present. */
  current: boolean
}

export type StructuredAgentSessionReadOwner = {
  publishCreated: (page: AgentSessionHistoryPage) => void
  activate: () => () => void
  resync?: () => void
  dispose: () => void
  getSnapshot: () => StructuredAgentSessionReadSnapshot
  loadOlder: () => Promise<NativeChatOlderPageResult>
  subscribe: (listener: () => void) => () => void
}
