// The phase of a pane's windowed transcript read, and the one question
// consumers actually ask of it: has the read settled yet? Split from
// use-native-chat-live-session.ts so the phase vocabulary is readable on its
// own — several surfaces branch on it, only one drives the read.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'

// Why: a new session's transcript can take minutes to appear on disk (#8401).
// Only a guess at the flush delay — a host that reports the transcript pending
// overrides it outright. Exported for tests.
export const NOTFOUND_RETRY_WINDOW_MS = 60_000

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

/** Fold an older-history page into the loaded read. An offset-anchored
 *  continuation page covers records strictly BEFORE the loaded window, so it
 *  prepends; a widened tail read re-read the whole window, so it replaces
 *  (XLR-R1-001). Prepending onto a non-'ready' phase would invent a window that
 *  was never read, so that degrades to a replacement. */
export function applyNativeChatEarlierPage(
  previous: ReadState,
  messages: NativeChatMessage[],
  page: { beforeOffset?: number }
): ReadState {
  return page.beforeOffset === undefined || previous.phase !== 'ready'
    ? { phase: 'ready', messages }
    : { phase: 'ready', messages: [...messages, ...previous.messages] }
}

/** Identity of the transcript a pane is reading. Any change here retires the current read and
 *  starts a new one, so it is computed in one place rather than inline in the hook. */
export function nativeChatTranscriptSourceKey(args: {
  paneKey: string
  agent: string
  sessionId: string | null
  transcriptPath?: string | null
  runtimeEnvironmentId?: string | null
}): string {
  return JSON.stringify([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null
  ])
}
