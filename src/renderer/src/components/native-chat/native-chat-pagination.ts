// Pure pagination math for the native-chat read window. The renderer reads the
// transcript tail with a `limit`; when the user scrolls to the top it raises the
// limit by a page to load older history. Kept pure (no React/IO) so the limit
// growth and the "is there more?" decision are unit-testable.

import {
  NATIVE_CHAT_REMOTE_DEFAULT_WINDOW,
  NATIVE_CHAT_REMOTE_MAX_WINDOW
} from '../../../../shared/native-chat-types'

// First page mirrors the desktop default window (300 most-recent turns) so the
// initial paint matches the prior behavior; each load-earlier grows by a page.
export const NATIVE_CHAT_INITIAL_LIMIT = 300
export const NATIVE_CHAT_PAGE = 200

/** The limit to request for the next older page, capped at the runtime's read
 *  ceiling (XLR-049).
 *
 *  The cap is a mixed-version requirement, not an optimization: runtimes that
 *  predate the host-side clamp validate the same bound by REJECTING a wider
 *  `limit`, and `loadEarlier` swallows a rejected read — keeping both the old
 *  limit and the 'filled' verdict — so one over-wide request makes every later
 *  attempt repeat it and leaves the oldest records unreachable. Growing only up
 *  to the ceiling keeps every request acceptable to old and new hosts alike;
 *  past it neither host can return more anyway. */
export function nextNativeChatLimit(currentLimit: number): number {
  return Math.min(currentLimit + NATIVE_CHAT_PAGE, NATIVE_CHAT_REMOTE_MAX_WINDOW)
}

/** The read window a pane currently has loaded: the tail `limit` it asked for,
 *  plus the continuation cursor the last read reported. */
export type NativeChatReadWindow = {
  limit: number
  /** Byte offset of the oldest LOADED record. Undefined until a read reports
   *  one, and cleared whenever an authoritative frame replaces the window. */
  beforeOffset?: number
}

/** One older-history request. `beforeOffset` marks it as an offset-anchored
 *  continuation, which sits strictly before the loaded window and so must be
 *  PREPENDED; without it the request is a wider tail read that replaces. */
export type NativeChatReadPage = {
  /** The `limit` to request. */
  limit: number
  beforeOffset?: number
  /** The tail limit the window keeps afterwards. A continuation page must NOT
   *  shrink it to its own page size: the tail stays saturated at the ceiling,
   *  which is exactly what keeps the next page offset-anchored instead of
   *  resuming a growth that cannot reach any further back. */
  tailLimit: number
}

/** The window every session starts from. Shared and frozen rather than rebuilt per hook: every
 *  writer REPLACES `windowRef.current` (never mutates it in place), so one instance is safe — and
 *  a bare reference keeps the lazy-useRef ratchet satisfied without a second initialisation line. */
export const INITIAL_NATIVE_CHAT_READ_WINDOW: NativeChatReadWindow = Object.freeze({
  limit: NATIVE_CHAT_INITIAL_LIMIT
})

export function initialNativeChatReadWindow(): NativeChatReadWindow {
  return { limit: NATIVE_CHAT_INITIAL_LIMIT }
}

/** The next older page to request.
 *
 *  Growing `limit` wins while it still grows: a wider tail re-reads everything
 *  behind it, so it cannot leave a hole. But growth saturates at the wire
 *  ceiling, and past that the limit alone can no longer reach further back —
 *  every later request returns the identical tail and keeps the 'filled'
 *  verdict, so load-earlier spins and the older records are unreachable
 *  (XLR-R1-001). From there the cursor takes over: one page ending at the
 *  oldest loaded record's offset, which the caller prepends.
 *
 *  With no cursor yet — a host too old to report one, or a frame that just
 *  replaced the window — a saturated request stays a plain ceiling-wide tail
 *  read. That is the pre-existing behavior AND the read that re-establishes the
 *  cursor. It gets exactly one attempt: if that read comes back cursorless too,
 *  the host does not do cursors and `nativeChatOlderHistoryFromReadResult`
 *  retires load-earlier rather than let it repeat forever (XLR-R8-002). */
export function nextNativeChatPage(window: NativeChatReadWindow): NativeChatReadPage {
  const grown = nextNativeChatLimit(window.limit)
  if (grown > window.limit || window.beforeOffset === undefined) {
    return { limit: grown, tailLimit: grown }
  }
  return { limit: NATIVE_CHAT_PAGE, beforeOffset: window.beforeOffset, tailLimit: window.limit }
}

/** Whether an older page may still exist: the last read filled the window, so
 *  there could be more behind it. If the read returned fewer than requested we
 *  reached the head of the transcript and there is nothing older to load.
 *
 *  Affordance grade only (SA-008). An exact fill is ambiguous — a transcript of
 *  exactly `requestedLimit` records returns the same count as one with a
 *  thousand behind it — and this resolves the ambiguity toward `true` because
 *  the cost of being wrong is one wasted read. Nothing irreversible may key off
 *  it; proof of omission comes from the host (`NativeChatTranscriptWindow`). */
export function hasMoreNativeChatHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit
}

/** What the pane knows about records older than its loaded window.
 *  - 'none': the read reached the transcript head.
 *  - 'filled': the read returned every record it asked for, so older ones MAY
 *    exist. Enough for the load-earlier affordance, never proof (SA-008).
 *  - 'measured': the host counted past the limit and saw a record behind the
 *    window. The only verdict a horizon inference may be drawn from. */
export type NativeChatOlderHistoryVerdict = 'none' | 'filled' | 'measured'

/** The verdict a locally derived read supports: it reports a count, never a
 *  measurement, so it can never rise above 'filled'. */
export function nativeChatOlderHistoryFromRead(
  returnedCount: number,
  requestedLimit: number
): NativeChatOlderHistoryVerdict {
  return hasMoreNativeChatHistory(returnedCount, requestedLimit) ? 'filled' : 'none'
}

type NativeChatReadResult =
  | { messages: readonly unknown[]; hasMore?: boolean; beforeOffset?: number }
  | undefined

/** What a read was graded against: the bare tail `limit` of the seed read, or
 *  the whole page a load-earlier issued. A page carries what a bare limit
 *  cannot — whether growth is exhausted and whether the request was
 *  offset-anchored — which is what separates "nothing older exists" from
 *  "nothing older is reachable from here". */
export type NativeChatGradedRequest = number | NativeChatReadPage

/** The seed read's verdict. The host's own `hasMore` is a measurement, but a
 *  read is still graded no higher than 'filled' (SA-008): only a
 *  snapshot/replacement frame may set the `omitsOlderRecords` horizon consumers
 *  read as proof.
 *
 *  Its ABSENCE is the mixed-version case this exists for (XLR-R3-003). A host
 *  too old to report `hasMore` is also too old to honour the requested `limit`,
 *  so it answers with its own fixed default window however much was asked for.
 *  Grading that full 40-record page against a 300-record request under-fills it
 *  and asserts a transcript head the host never measured — which retires
 *  Load-earlier for the rest of the session, exactly the withdrawal
 *  `nativeChatBridgeHasMore` already prevents on the subscription path
 *  (XLR-008). Capping the graded limit can only over-offer, and an over-eager
 *  offer costs one wasted read where an over-eager withdrawal costs the
 *  history. */
function nativeChatSeedReadVerdict(
  result: NativeChatReadResult,
  requestedLimit: number
): NativeChatOlderHistoryVerdict {
  if (result?.hasMore !== undefined) {
    return result.hasMore ? 'filled' : 'none'
  }
  return nativeChatOlderHistoryFromRead(
    result?.messages.length ?? 0,
    Math.min(requestedLimit, NATIVE_CHAT_REMOTE_DEFAULT_WINDOW)
  )
}

/** A load-earlier page's verdict, which must be able to withdraw where the seed
 *  read deliberately cannot (XLR-R8-002). The seed's leniency exists so the
 *  control is OFFERED on a host that cannot report `hasMore`; reusing it here
 *  means a page that provably made no progress is still graded 'filled', so the
 *  control never retires and each click repeats a request that already failed.
 *
 *  Two withdrawals only a page supports:
 *
 *  1. A short answer is graded against the FULL requested limit, uncapped. A
 *     host that honours `limit` returns fewer only at the transcript head; one
 *     that ignores it answers with its fixed window however much more we ask
 *     for. Neither has anything further this path can reach, so the wasted read
 *     the seed's over-offer paid for is spent here exactly once.
 *  2. A page that exhausted growth (`tailLimit` at the wire ceiling) and still
 *     came back with no cursor has no continuation left: the limit cannot widen
 *     and `nextNativeChatPage` has no `beforeOffset` to anchor to, so every
 *     later request is byte-identical to this one. */
function nativeChatEarlierPageVerdict(
  result: NativeChatReadResult,
  page: NativeChatReadPage
): NativeChatOlderHistoryVerdict {
  const returned = result?.messages.length ?? 0
  const reachedHead =
    result?.hasMore !== undefined
      ? !result.hasMore
      : !hasMoreNativeChatHistory(returned, page.limit)
  if (reachedHead) {
    return 'none'
  }
  const strandedAtCeiling =
    result?.beforeOffset === undefined && page.tailLimit >= NATIVE_CHAT_REMOTE_MAX_WINDOW
  return strandedAtCeiling ? 'none' : 'filled'
}

/** The verdict a direct `readSession` result supports, graded against what was
 *  actually requested. */
export function nativeChatOlderHistoryFromReadResult(
  result: NativeChatReadResult,
  request: NativeChatGradedRequest
): NativeChatOlderHistoryVerdict {
  return typeof request === 'number'
    ? nativeChatSeedReadVerdict(result, request)
    : nativeChatEarlierPageVerdict(result, request)
}

/** The verdict a snapshot/replacement frame supports. A `hasMore` the emitter
 *  sent counts strictly past the limit (transcript-tail-reader.ts), so it is a
 *  measurement.
 *
 *  `inferred` marks the one case where it is not (SA-011): an older runtime that
 *  omits `hasMore` leaves the client bridges (native-chat-session-transport.ts,
 *  web-native-chat-api.ts) to synthesize it from `messages.length >= limit` —
 *  the same ambiguous exact fill a local read reports, and no more. */
export function nativeChatOlderHistoryFromFrame(
  hasMore: boolean,
  inferred = false
): NativeChatOlderHistoryVerdict {
  if (!hasMore) {
    return 'none'
  }
  return inferred ? 'filled' : 'measured'
}

/** The `hasMore` a client bridge forwards for a window-bearing frame, plus the
 *  provenance label when the bridge had to synthesize it.
 *
 *  A runtime too old to send `hasMore` leaves only the exact fill to go on, so
 *  the bridges infer it and label the guess (SA-011). This applies to every
 *  frame that carries `hasMore` — reconnect snapshots and inode replacements as
 *  much as the initial one (SA-012/SA-013) — because defaulting an omission to
 *  `false` asserts a transcript head the host never measured, and the 'none'
 *  verdict that follows hides Load-earlier for the rest of the session.
 *
 *  An emitted `false` is a real measurement and is passed through untouched.
 *
 *  With no `limit` the fill must be graded against the host's default window,
 *  not this module's first page (SA-014): the RPC substitutes its own default
 *  for an omitted limit, so grading a full default page against the larger
 *  initial limit would under-fill it and assert a head the host never saw.
 *
 *  A REQUESTED limit is capped at that same default for the same reason
 *  (XLR-008): the only hosts that omit `hasMore` are ones that also
 *  predate the client-supplied `limit`, so they answer with their own fixed
 *  window however much was asked for. Grading a full 40-record legacy window
 *  against a 300-record request under-fills it and asserts a transcript head
 *  the host never measured -- which then retires Load-earlier for the whole
 *  session. Capping can only over-offer, and an over-eager offer costs one
 *  wasted read (SA-008) where an over-eager withdrawal costs the history. */
export function nativeChatBridgeHasMore(
  hasMore: boolean | undefined,
  returnedCount: number,
  requestedLimit: number | undefined
): { hasMore: boolean; hasMoreInferred?: true } {
  if (hasMore !== undefined) {
    return { hasMore }
  }
  const gradedLimit = Math.min(
    requestedLimit ?? NATIVE_CHAT_REMOTE_DEFAULT_WINDOW,
    NATIVE_CHAT_REMOTE_DEFAULT_WINDOW
  )
  return hasMoreNativeChatHistory(returnedCount, gradedLimit)
    ? { hasMore: true, hasMoreInferred: true }
    : { hasMore: false }
}

/** What a loaded transcript window is allowed to prove about older history. */
export type NativeChatTranscriptWindow = {
  /** The windowed read settled ('ready'); before that the list holds only live
   *  appends, so its oldest row is not the window's horizon. */
  settled: boolean
  /** The host strictly observed a record behind the window's oldest row.
   *
   *  Deliberately NOT the `hasMore` affordance (SA-008): that one is true of an
   *  exactly-full window too, which may equally be a window sitting on the
   *  transcript head, and mistaking it for proof permanently retires an advisor
   *  card whose row simply had not been persisted yet. Only the host counts
   *  past the limit (transcript-tail-reader.ts), so only a host snapshot or
   *  replacement frame may set this. */
  omitsOlderRecords: boolean
}

/** Whether the window provably omits older records. Required before reading its
 *  oldest row as a horizon: only a window with something behind it can have
 *  scrolled past a record, so on a window that reaches the head of the
 *  transcript "everything here is newer than X" says nothing about X. */
export function nativeChatWindowOmitsOlderRecords(
  window: NativeChatTranscriptWindow | null | undefined
): boolean {
  return window?.settled === true && window.omitsOlderRecords
}

/** The pane's effective older-history verdict: only reaching the transcript
 *  head withdraws load-earlier.
 *
 *  Nothing about the RPC session may withdraw it (SA-009, SA-010). RPC history
 *  walks the active leaf while the JSONL transcript also retains the records of
 *  abandoned branches, so after a rewind the two cover different record sets and
 *  covering one says nothing about the other. That holds for a merely 'filled'
 *  verdict too, because 'measured' demotes to 'filled' the moment load-earlier
 *  re-derives the verdict at a wider limit (use-native-chat-live-session.ts) —
 *  withdrawing there would hide the control over records the host had already
 *  counted, leaving them no path back. An over-eager offer costs one read
 *  (SA-008); an over-eager withdrawal costs the history.
 */
export function canLoadEarlierNativeChatHistory(
  transcriptOlderHistory: NativeChatOlderHistoryVerdict
): boolean {
  return transcriptOlderHistory !== 'none'
}
