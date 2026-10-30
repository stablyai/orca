import type { AppState } from '@/store/types'
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
  trackSend: (id: string) => {
    issue: () => void
    settle: (uncertain: boolean) => void
  }
  admit: (
    intent: string,
    valid: () => boolean,
    effect: (attempt: StructuredAgentSessionAdmission) => void | Promise<void>
  ) => Promise<void>
  publishCreated: (page: AgentSessionHistoryPage) => void
  activate: (effects: StructuredAgentSessionReadEffects) => () => void
  resync?: () => void
  dispose: () => void
  getSnapshot: () => StructuredAgentSessionReadSnapshot
  loadOlder: () => Promise<NativeChatOlderPageResult>
  subscribe: (listener: () => void) => () => void
  subscribeCommandsChanged: (listener: () => void) => () => void
}

export type StructuredAgentSessionAdmission = {
  current: () => boolean
  busy: () => boolean
  signal: AbortSignal
}

export type StructuredAgentSessionReadEffects = {
  getState: () => AppState
  subscribeRetryNow: (retry: () => void) => () => void
}
