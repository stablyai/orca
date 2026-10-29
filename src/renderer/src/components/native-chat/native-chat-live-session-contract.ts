import type { AsyncQuestionContributor } from '../../../../shared/native-chat/input/native-chat-ask'
import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatSession,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

export type ReadState =
  | { phase: 'loading' }
  /** Awaiting an unpublished transcript is unsettled; the empty list is not real history yet. */
  | { phase: 'awaiting' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/** loading/awaiting have no settled history; errors remain distinct so their surface stays visible. */
export function isNativeChatTranscriptUnsettled(phase: ReadState['phase']): boolean {
  return phase === 'loading' || phase === 'awaiting'
}

export type NativeChatLiveSession = NativeChatSession & {
  asyncQuestionContributors?: AsyncQuestionContributor[]
  asyncQuestion?: AskPrompt | null
  /** Latest provider turn boundary, used to settle orphaned running tool rows. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** Hook-reported human wait not yet ended by the transcript; absent on hookless lanes. */
  hookAwaitingInput?: boolean
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  loadingEarlier: boolean
  /** Reset paging failures when source/snapshot replacement starts a new generation. */
  olderHistoryGeneration: number
  /** Resolve after page publication; concurrent calls share the in-flight read. */
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  /** Use raw read phase for history decisions; a working hook can hide loading in session status. */
  readPhase: ReadState['phase']
  /** True only when caught up to host state; terminal-backed reads cannot prove what arrived while hidden. */
  readCurrent?: boolean
}

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` hook-entry key. */
  paneKey: string
  agent: AgentType
  /** Null until reported; use live hook state before there is a session to read. */
  sessionId: string | null
  /** Prefer the hook’s authoritative path over reconstruction from sessionId. */
  transcriptPath?: string | null
  /** Non-null routes reads/subscriptions to the owning remote host; null uses local IPC. */
  runtimeEnvironmentId?: string | null
  /** False suspends transcript IO while retaining the last committed session. */
  enabled?: boolean
}
