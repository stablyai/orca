import type {
  AgentType,
  NativeChatMessage,
  NativeChatSession
} from '../../../../shared/native-chat-types'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` key — selects the live hook entry. */
  paneKey: string
  agent: AgentType
  /** The agent's own session id, or null before it reports one. */
  sessionId: string | null
  /** Authoritative transcript path reported by the hook. */
  transcriptPath?: string | null
  /** Non-null routes reads and subscriptions to the runtime owner. */
  runtimeEnvironmentId?: string | null
  /** False suspends transcript IO while retaining the last committed session. */
  enabled?: boolean
}

export type ReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => void
  /** Raw read phase remains loading even when live hook status outranks it. */
  readPhase: ReadState['phase']
  /** Same-renderer ordering for live rows received after an optimistic action. */
  transcriptOrder: NativeChatTranscriptOrder
}
