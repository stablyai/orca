// Folds a hydrated OMP RPC history snapshot into the transcript-derived list.
//
// The two sources describe the same conversation but share no id: an RPC
// history message is a bare `AgentMessage` with no wire id (see
// src/main/omp-rpc/omp-rpc-history-decode.ts). What they do share is the
// message's own clock, which the omp decoder keeps as `originTimestamp` on both
// paths (src/main/native-chat/transcript-line-decoders-omp.ts), plus the turn's
// content and its tool identity. Those three together are what identifies a
// record across the sources, and nothing else is: content alone cannot tell a
// shared record from a later repeat of it, and the rendered `timestamp` alone is
// the wrong clock — for a transcript record it is the envelope's write time,
// stamped when the line was persisted and up to tens of seconds behind the
// message it wraps.
//
// ORDER, though, is not the clock's job. OMP appends a turn queued during a long
// response after the records that outran it, so a snapshot's clocks step
// backwards while its RECORD order stays logical. So the walk aligns the two
// windows on identity in record order — the transcript wins every record both
// carry — and consults clocks only to place a run neither window anchors.

import {
  isTextBlock,
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { normalizeImageTranscriptMessages } from '../../../../shared/native-chat-image-transcript-markers'
import { nativeChatTurnContentKey } from './native-chat-session-assembler'

/** One merged record, tagged with the window it came from so the render-clock
 *  repair below can leave transcript records' displayed times alone. */
type MergedRecord = { message: NativeChatMessage; fromTranscript: boolean }

/** The reading of a record's clock that is comparable ACROSS sources. */
function messageClock(message: NativeChatMessage): number | null {
  return message.originTimestamp ?? message.timestamp
}

/** Per-record clocks for one window, or all-null when the window carries no
 *  clock at all. A record with no clock of its own takes its predecessor's — it
 *  follows that record in the window, so it belongs to that instant — and a
 *  leading gap takes the window's first known clock, by the same argument from
 *  the other side. */
function windowClocks(messages: readonly NativeChatMessage[]): (number | null)[] {
  const clocks = messages.map(messageClock)
  const earliest = clocks.find((clock) => clock !== null) ?? null
  if (earliest === null) {
    return clocks.map(() => null)
  }
  let running = earliest
  return clocks.map((clock) => {
    running = clock ?? running
    return running
  })
}

/** The part of a record's identity the turn key leaves out. Two tool results at
 *  the same instant can carry byte-identical output and still be different
 *  records — only the call they answer and whether they failed say so. */
function toolIdentity(message: NativeChatMessage): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (isToolCallBlock(block)) {
      parts.push(`call:${block.toolCallId ?? ''}`)
    } else if (isToolResultBlock(block)) {
      parts.push(`result:${block.toolCallId ?? ''}:${block.isError === true ? 'error' : 'ok'}`)
    }
  }
  return parts.join('|')
}

/** The verbatim text the turn key folds away. Both windows decode the same
 *  `AgentMessage` through the same omp decoder (omp-rpc-history-decode.ts hands
 *  its rows to `decodeOmpTranscriptLine`), so a shared record's text matches
 *  byte for byte. The turn key's case and whitespace folding is there for dedupe
 *  across sources that phrase a turn differently; here it would only conflate
 *  two same-clock turns differing in case, pairing the transcript's copy with
 *  the wrong one and losing the other at a pagination boundary. */
function exactText(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\u0001')
}

function identityKeys(
  messages: readonly NativeChatMessage[],
  clocks: readonly (number | null)[],
  withClock: boolean
): string[] {
  return messages.map((message, index) => {
    const clock = withClock ? (clocks[index] ?? '') : ''
    const parts = [
      String(clock),
      nativeChatTurnContentKey(message),
      exactText(message),
      toolIdentity(message)
    ]
    return parts.join('\u0000')
  })
}

/** Index of the first hydrated record at or after `cursor` carrying `key`, or
 *  null. Per-key cursors keep the whole alignment linear in the two windows. */
function nextAnchor(
  byKey: Map<string, number[]>,
  scanned: Map<string, number>,
  key: string,
  cursor: number
): number | null {
  const indices = byKey.get(key)
  if (!indices) {
    return null
  }
  let scan = scanned.get(key) ?? 0
  while (scan < indices.length && indices[scan]! < cursor) {
    scan += 1
  }
  scanned.set(key, scan)
  return indices[scan] ?? null
}

/** Emits the records neither window anchors: a run one window holds that the
 *  other never reached. With both windows contributing, the clocks decide which
 *  run came first, and a tie keeps the transcript ahead — the drain reaches back
 *  further than the bounded transcript read, so an unanchored hydrated run is
 *  usually the older one, but never at the cost of reordering a shared instant. */
function pushUnanchored(
  merged: MergedRecord[],
  transcript: { messages: readonly NativeChatMessage[]; clocks: readonly (number | null)[] },
  pending: readonly number[],
  hydrated: { messages: readonly NativeChatMessage[]; clocks: readonly (number | null)[] },
  hydratedStart: number,
  hydratedEnd: number
): void {
  const pushTranscript = (): void => {
    for (const index of pending) {
      merged.push({ message: transcript.messages[index]!, fromTranscript: true })
    }
  }
  const pushHydrated = (): void => {
    for (let index = hydratedStart; index < hydratedEnd; index += 1) {
      merged.push({ message: hydrated.messages[index]!, fromTranscript: false })
    }
  }
  const transcriptLast = transcript.clocks[pending.at(-1) ?? -1] ?? null
  const hydratedLast = hydrated.clocks[hydratedEnd - 1] ?? null
  const hydratedIsOlder =
    pending.length === 0 ||
    (hydratedEnd > hydratedStart &&
      transcriptLast !== null &&
      hydratedLast !== null &&
      hydratedLast < transcriptLast)
  if (hydratedIsOlder) {
    pushHydrated()
    pushTranscript()
    return
  }
  pushTranscript()
  pushHydrated()
}

/** Ordered alignment of the two windows in RECORD order. Every transcript
 *  record is emitted — that invariant is what lets the caller detect a snapshot
 *  that added nothing by length alone — and a hydrated record is dropped only
 *  where a transcript record carries the same identity. */
function alignWindows(
  transcript: { messages: readonly NativeChatMessage[]; clocks: readonly (number | null)[] },
  transcriptKeys: readonly string[],
  hydrated: { messages: readonly NativeChatMessage[]; clocks: readonly (number | null)[] },
  hydratedKeys: readonly string[]
): MergedRecord[] {
  const byKey = new Map<string, number[]>()
  hydratedKeys.forEach((key, index) => {
    const indices = byKey.get(key)
    if (indices) {
      indices.push(index)
    } else {
      byKey.set(key, [index])
    }
  })
  const scanned = new Map<string, number>()
  const merged: MergedRecord[] = []
  let cursor = 0
  let pending: number[] = []
  for (let index = 0; index < transcript.messages.length; index += 1) {
    const anchor = nextAnchor(byKey, scanned, transcriptKeys[index] ?? '', cursor)
    if (anchor === null) {
      pending.push(index)
      continue
    }
    pushUnanchored(merged, transcript, pending, hydrated, cursor, anchor)
    merged.push({ message: transcript.messages[index]!, fromTranscript: true })
    pending = []
    cursor = anchor + 1
  }
  pushUnanchored(merged, transcript, pending, hydrated, cursor, hydrated.messages.length)
  return merged
}

/** True when the run's own clocks already sort it where the walk put it. */
function fitsSpan(
  run: readonly NativeChatMessage[],
  lower: number | null,
  upper: number | null
): boolean {
  let previous = lower
  for (const message of run) {
    const own = message.timestamp
    if (
      own === null ||
      (previous !== null && own <= previous) ||
      (upper !== null && own >= upper)
    ) {
      return false
    }
    previous = own
  }
  return true
}

/** The clocks an UNBOUNDED run renders on: each record keeps its own whenever
 *  that already sorts after the record before it, and only a clock that breaks
 *  the order is replaced, by the smallest value that restores it.
 *
 *  Why not restamp the whole run from its earliest clock (XLR-R3-004, cross-lab
 *  review round 3): with no transcript to align against, the run IS the whole
 *  history, so a single inversion anywhere in it dragged every later record —
 *  including a prompt delivered seconds ago — back into the era of the oldest
 *  one. A pending send whose optimistic entry has no boundary message is
 *  reconciled by comparing the rendered clock against `sentAt`
 *  (native-chat-pending-occurrence.ts), so a prompt restamped into the past is
 *  never recognized as delivered and renders twice. Repairing only the records
 *  that actually break the order keeps every conforming clock — above all the
 *  newest one — while still holding OMP's record order against the list's
 *  defensive re-sort. */
function monotonicRunClocks(run: readonly NativeChatMessage[]): number[] {
  const clocks: number[] = []
  let previous: number | null = null
  for (const message of run) {
    const own = message.timestamp
    const next =
      own !== null && (previous === null || own > previous)
        ? own
        : previous === null
          ? 0
          : previous + 1
    clocks.push(next)
    previous = next
  }
  return clocks
}

/** A strictly increasing position inside the span, clear of both bounds.
 *
 *  A span whose upper bound is not strictly above its lower one holds no
 *  position at all — equal transcript clocks are ordinary (upstream stamps
 *  entries at millisecond resolution), and a descending pair happens whenever
 *  the transcript's own clocks step backwards. The old fallback answered that
 *  with `upper - 1 + step`, which lands BELOW the lower anchor and sorts the
 *  run ahead of the record the walk placed it after — the one direction that
 *  contradicts the aligned order outright (XLR-012). Fall back to the lower
 *  anchor alone instead: the run still cannot be squeezed between two clocks
 *  that leave no gap, but it never sorts ahead of the record it follows, and
 *  the anchors' own inversion stays the transcript's rather than this repair's.
 *
 *  An OPEN span (no upper anchor at all) is not that case and must not share
 *  its answer (XLR-037): nothing above needs preserving, so the run climbs in
 *  whole units from the base. Handing every record the base itself collapsed
 *  the run onto one clock, and the list's tie-break for one clock is lexical on
 *  id — unpadded positional ids order 0, 1, 10, 11, 2, which is exactly the OMP
 *  record order this repair exists to hold. */
function spanPosition(
  lower: number | null,
  upper: number | null,
  offset: number,
  count: number
): number {
  const step = (offset + 1) / (count + 1)
  if (lower === null) {
    return upper === null ? offset : upper - 1 + step
  }
  if (upper !== null && upper > lower) {
    return lower + (upper - lower) * step
  }
  return upper === null ? lower + offset + 1 : lower
}

/** Room for a run whose span is zero-width: both anchors share one clock, so
 *  no value sorts strictly between them and the list breaks that tie by id
 *  rather than by record order. The room is borrowed from ABOVE the upper
 *  anchor, which means moving transcript records — the single exception to
 *  "hydrated records only" below.
 *
 *  Above and never below (XLR-R4-001, cross-lab review): pushing the LOWER
 *  anchor down is the one repair that can move a transcript record BELOW its
 *  own persisted clock, and on the first prompt of a session that anchor is the
 *  user row an optimistic echo is waiting for. An echo issued with no boundary
 *  message is recognized only by `timestamp >= sentAt`
 *  (native-chat-pending-occurrence.ts), so a user row restamped into the past
 *  is never matched and the prompt renders twice. A lower bound is indifferent
 *  to a raise, so this direction is the safe one — the same reason
 *  `monotonicRunClocks` only ever repairs upwards (XLR-R3-004).
 *
 *  Still bounded by the record already above (XLR-027), and by one whole tick
 *  even when nothing follows: the borrow stays inside the millisecond the
 *  anchor already owns, so it cannot climb past whatever else sits in the gap
 *  above it.
 *
 *  Which record that bound comes from is the whole question (XLR-R5-003,
 *  cross-lab review). Reading the one immediately above the anchor treated an
 *  unrepaired record of the NEXT hydrated run as a fixed ceiling: sharing the
 *  anchor's clock, it looked like a span with no room, the first gap was left
 *  unrepaired, and the list's id tie-break reordered it. Nothing at or below
 *  the anchor's clock is a ceiling — every such record has to be raised too —
 *  so the repair takes the whole JAM (the anchor plus everything above it still
 *  sharing that clock) and spreads it, with the first record that actually
 *  sorts above it as the bound. Every position is strictly above `lower`, so
 *  this stays a raise for each record it moves. Null when the span is not
 *  zero-width, leaving the tie to the generic path. */
function borrowRoomAboveAnchor(
  merged: readonly MergedRecord[],
  end: number,
  lower: number | null,
  upper: number | null,
  count: number
): { clocks: number[]; jamEnd: number } | null {
  if (lower === null || upper !== lower) {
    return null
  }
  let jamEnd = end
  while (jamEnd < merged.length) {
    const clock = merged[jamEnd]!.message.timestamp
    if (clock !== null && clock > lower) {
      break
    }
    jamEnd += 1
  }
  const ceiling = merged[jamEnd]?.message.timestamp ?? null
  const total = count + jamEnd - end
  const step = (Math.min(ceiling ?? Infinity, lower + 1) - lower) / (total + 1)
  return {
    clocks: Array.from({ length: total }, (_, offset) => lower + step * (offset + 1)),
    jamEnd
  }
}

/** The walk's order is the answer, but the list re-sorts defensively on the
 *  rendered clock (native-chat-message-grouping.ts), and the two sources stamp
 *  that field from different clocks — so a snapshot-only record can sort itself
 *  back ahead of a transcript record it must follow. Restamp only those
 *  records, and only when their own clock does not already fit the span their
 *  transcript neighbours pin down — the one exception being the same-clock jam
 *  a zero-width span forces up into its own gap (`borrowRoomAboveAnchor`).
 *  `originTimestamp`, the identity clock, is never touched and never
 *  rendered. */
function reconcileRenderClocks(merged: readonly MergedRecord[]): NativeChatMessage[] {
  const reconciled: NativeChatMessage[] = []
  let index = 0
  while (index < merged.length) {
    if (merged[index]!.fromTranscript) {
      reconciled.push(merged[index]!.message)
      index += 1
      continue
    }
    let end = index
    while (end < merged.length && !merged[end]!.fromTranscript) {
      end += 1
    }
    // A run is maximal, so either neighbour is a transcript record or absent.
    const lower = index === 0 ? null : reconciled.at(-1)!.timestamp
    const upper = end === merged.length ? null : merged[end]!.message.timestamp
    const run = merged.slice(index, end).map((record) => record.message)
    if (fitsSpan(run, lower, upper)) {
      reconciled.push(...run)
    } else if (lower === null && upper === null) {
      const clocks = monotonicRunClocks(run)
      reconciled.push(
        ...run.map((message, offset) =>
          message.timestamp === clocks[offset]!
            ? message
            : { ...message, timestamp: clocks[offset]! }
        )
      )
    } else {
      const borrowed = borrowRoomAboveAnchor(merged, end, lower, upper, run.length)
      if (borrowed !== null) {
        // The jam's own records are emitted here, transcript ones included:
        // this branch is the single exception to "hydrated records only".
        reconciled.push(
          ...merged.slice(index, borrowed.jamEnd).map((record, offset) => ({
            ...record.message,
            timestamp: borrowed.clocks[offset]!
          }))
        )
        index = borrowed.jamEnd
        continue
      }
      // A run with no lower anchor here always has an upper one: the fully
      // unbounded case is repaired monotonically above.
      reconciled.push(
        ...run.map((message, offset) => ({
          ...message,
          timestamp: spanPosition(lower, upper, offset, run.length)
        }))
      )
    }
    index = end
  }
  return reconciled
}

/**
 * Transcript wins every record both sources carry; the hydrated snapshot
 * contributes only what the transcript is missing — the tail OMP has not
 * flushed yet, and history older than the transcript read window. Returns the
 * transcript array by identity when there is nothing hydrated (or when the
 * snapshot adds nothing), keeping the non-RPC pane off the rebuild path.
 */
export function mergeOmpRpcHydratedHistory(
  transcript: readonly NativeChatMessage[],
  hydrated: readonly NativeChatMessage[]
): NativeChatMessage[] {
  if (hydrated.length === 0) {
    return transcript as NativeChatMessage[]
  }
  // Snapshot records carry the same `[Image: source: …]` markers the transcript
  // does — they come off the same omp decoder — so they need the same
  // normalization the assembler would have applied on the fallback path.
  const normalized = normalizeImageTranscriptMessages([...hydrated])
  if (transcript.length === 0) {
    // No transcript record to align against, but the list still re-sorts on the
    // rendered clock, which a queued turn's backwards-stepping clock would use
    // to undo OMP's record order.
    return reconcileRenderClocks(normalized.map((message) => ({ message, fromTranscript: false })))
  }

  const transcriptWindow = { messages: transcript, clocks: windowClocks(transcript) }
  const hydratedWindow = { messages: normalized, clocks: windowClocks(normalized) }
  // A window with no clock at all leaves content and tool identity as the only
  // evidence; keying the other window's clock in would then match nothing.
  // Out of reach for an omp session, where `AgentMessage.timestamp` is required
  // on every message variant upstream, so both windows carry clocks.
  const withClock =
    transcriptWindow.clocks.some((clock) => clock !== null) &&
    hydratedWindow.clocks.some((clock) => clock !== null)
  const merged = alignWindows(
    transcriptWindow,
    identityKeys(transcript, transcriptWindow.clocks, withClock),
    hydratedWindow,
    identityKeys(normalized, hydratedWindow.clocks, withClock)
  )
  // The walk emits every transcript record, so an unchanged length means no
  // hydrated record survived — hand back the array itself, since the memoized
  // consumers downstream key off that reference.
  return merged.length === transcript.length
    ? (transcript as NativeChatMessage[])
    : reconcileRenderClocks(merged)
}
