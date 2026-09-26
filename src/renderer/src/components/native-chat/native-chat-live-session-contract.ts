// What a live native-chat session publishes to the view: the session itself, its
// raw read phase, and the older-history pagination controls.

import type {
  NativeChatMessage,
  NativeChatSession,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

export type ReadState =
  | { phase: 'loading' }
  /** The host reported no transcript behind this window yet: rendered, but not a
   *  settled read, so nothing may treat the empty list as real history. */
  | { phase: 'awaiting' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/** True while no transcript read has settled — 'loading' and 'awaiting' alike.
 *  Consumers that must not act on `messages` as real history use this, not a
 *  bare `!== 'ready'`, which would also swallow the error surface. */
export function isNativeChatTranscriptUnsettled(phase: ReadState['phase']): boolean {
  return phase === 'loading' || phase === 'awaiting'
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  /** Latest provider turn boundary, used to settle orphaned running tool rows. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Changes whenever older-history paging is reset (source swap, snapshot, replacement);
   *  a failed page belongs to one generation. */
  olderHistoryGeneration: number
  /** Page in older history. Resolves once the page has landed (or not); a call while
   *  one is in flight joins it. */
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  /** Raw initial-read phase. `status` is not a substitute: a live 'working' hook
   *  outranks (and so hides) 'loading', which would let a consumer deciding from
   *  an empty list treat an in-flight transcript as real history. */
  readPhase: ReadState['phase']
}
