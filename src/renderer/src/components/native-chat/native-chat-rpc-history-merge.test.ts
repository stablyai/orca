import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { prunePendingSends } from './native-chat-pending'
import { mergeOmpRpcHydratedHistory } from './native-chat-rpc-history-merge'

function transcriptMessage(
  id: string,
  text: string,
  overrides: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript',
    ...overrides
  }
}

function rpcMessage(
  id: string,
  text: string,
  overrides: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'rpc',
    ...overrides
  }
}

describe('mergeOmpRpcHydratedHistory', () => {
  it('returns the transcript array by identity when nothing was hydrated', () => {
    // The non-RPC pane is the hot path; it must not pay for a rebuild, and the
    // memoized consumers downstream key off this reference.
    const transcript = [transcriptMessage('a', 'hello')]

    expect(mergeOmpRpcHydratedHistory(transcript, [])).toBe(transcript)
  })

  it('returns the hydrated history when the transcript has nothing yet', () => {
    // The gap this closes: OMP has not flushed the session file the reader
    // watches, so the pane would otherwise render empty after a reconnect.
    const hydrated = [rpcMessage('omp-rpc-history-0', 'from the session')]

    expect(mergeOmpRpcHydratedHistory([], hydrated)).toEqual(hydrated)
  })

  it('collapses a turn carried by both sources onto the transcript copy', () => {
    // No duplicates: the two sources carry different ids for the same turn
    // (RPC history has no wire id at all), so the collapse is by turn content.
    const transcript = [transcriptMessage('disk-1', 'the same reply')]
    const hydrated = [rpcMessage('omp-rpc-history-0', 'the same reply')]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'disk-1', source: 'transcript' })
  })

  it('surfaces an RPC-only turn the transcript has not flushed', () => {
    // No gaps: the unflushed tail is exactly what hydration exists to recover.
    const transcript = [transcriptMessage('disk-1', 'first', { timestamp: 10 })]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'first', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'second', { timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => [message.id, message.source])).toEqual([
      ['disk-1', 'transcript'],
      ['omp-rpc-history-1', 'rpc']
    ])
  })

  it('orders a hydrated turn that predates the transcript window ahead of it', () => {
    // The transcript read is a bounded tail (native-chat-pagination.ts); the
    // hydrated drain is the whole session, so it legitimately reaches further back.
    const transcript = [transcriptMessage('disk-9', 'recent', { timestamp: 90 })]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'ancient', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'recent', { timestamp: 90 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-9'])
  })

  it('keeps two distinct same-text turns from collapsing into one', () => {
    // Asking the same thing twice is ordinary; the cross-source collapse must
    // not eat the repeat, so each transcript turn keeps its own hydrated peer.
    const transcript = [
      transcriptMessage('disk-1', 'again', { role: 'user', timestamp: 10 }),
      transcriptMessage('disk-2', 'again', { role: 'user', timestamp: 20 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'again', { role: 'user', timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['disk-1', 'disk-2'])
  })
})

describe('mergeOmpRpcHydratedHistory unequal windows', () => {
  it('keeps a repeated historical turn the transcript window does not reach', () => {
    // The two windows are different sizes, so the overlap has to be located by
    // POSITION, not by content identity: content-key dedupe would match both
    // hydrated 'again' turns to the single transcript one and drop the older.
    const transcript = [transcriptMessage('disk-2', 'again', { role: 'user', timestamp: 20 })]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'again', { role: 'user', timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-2'])
  })

  it('anchors the transcript on the NEWEST matching offset, since the read is a tail window', () => {
    // Three identical turns hydrated, two in the transcript window: the pair
    // must align with the last two, leaving exactly one older turn ahead.
    const transcript = [
      transcriptMessage('disk-2', 'ping', { role: 'user', timestamp: 20 }),
      transcriptMessage('disk-3', 'ping', { role: 'user', timestamp: 30 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'ping', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'ping', { role: 'user', timestamp: 20 }),
      rpcMessage('omp-rpc-history-2', 'ping', { role: 'user', timestamp: 30 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-2', 'disk-3'])
  })

  it('loses no turn when a one-record window sits inside a run of identical turns', () => {
    // Deliberately an invariant, not an exact attribution: with three
    // identical turns and a one-record window, no content-only rule can
    // recover WHICH of them the transcript held — the key excludes timestamps
    // on purpose (see native-chat-session-assembler.ts). All three render
    // identically, so what must hold is multiplicity: three turns out, the
    // transcript copy among them, and nothing dropped.
    const transcript = [transcriptMessage('disk-2', 'again', { role: 'user', timestamp: 20 })]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'again', { role: 'user', timestamp: 20 }),
      rpcMessage('omp-rpc-history-2', 'again', { role: 'user', timestamp: 30 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged).toHaveLength(3)
    expect(merged.map((message) => message.source)).toContain('transcript')
    expect(new Set(merged.map((message) => message.id)).size).toBe(3)
  })

  it('keeps a repeated turn when the two windows only partially overlap', () => {
    // The transcript reaches past the snapshot's newest record, so no offset
    // puts the whole transcript inside the snapshot. The overlap is still real
    // and still positional: content-keyed dedupe would fold BOTH hydrated
    // 'again' turns onto the single transcript copy and drop the older one.
    const transcript = [
      transcriptMessage('disk-2', 'again', { role: 'user', timestamp: 20 }),
      transcriptMessage('disk-3', 'new', { role: 'user', timestamp: 30 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'again', { role: 'user', timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-2', 'disk-3'])
  })

  it('keeps a hydrated head the transcript overtook on both ends', () => {
    // Snapshot head dropped by retention AND transcript running past its tail:
    // the aligned overlap is the middle, and neither end may be lost.
    const transcript = [
      transcriptMessage('disk-2', 'b', { timestamp: 20 }),
      transcriptMessage('disk-3', 'c', { timestamp: 30 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'b', { timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-2', 'disk-3'])
  })

  it('loses no repeat when the windows share no aligned overlap at all', () => {
    // Nothing lines up at any offset, so there is no positional answer left —
    // but multiplicity is still the invariant: two hydrated 'again' turns and
    // one transcript copy of a different turn are three turns, not two. The
    // shared turn still collapses; the repeat does not.
    const transcript = [
      transcriptMessage('disk-8', 'fresh', { role: 'user', timestamp: 80 }),
      transcriptMessage('disk-9', 'tail', { role: 'user', timestamp: 90 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'again', { role: 'user', timestamp: 20 }),
      rpcMessage('omp-rpc-history-2', 'fresh', { role: 'user', timestamp: 80 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'omp-rpc-history-1',
      'disk-8',
      'disk-9'
    ])
  })

  it('keeps a transcript record the snapshot never carried', () => {
    // A transcript longer than the snapshot still aligns — the overlap just
    // runs off its tail — and the local-only record must survive the splice.
    const transcript = [
      transcriptMessage('disk-1', 'shared', { timestamp: 10 }),
      transcriptMessage('disk-2', 'local only', { timestamp: 20 })
    ]
    const hydrated = [rpcMessage('omp-rpc-history-0', 'shared', { timestamp: 10 })]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['disk-1', 'disk-2'])
  })
})

describe('mergeOmpRpcHydratedHistory weak evidence', () => {
  it('refuses a lone coincidental key as proof the transcript reaches older than the snapshot', () => {
    // The snapshot's retained head is an OLD 'again'; the transcript tail is a
    // whole window of later activity that happens to contain its own newer
    // 'again'. Aligning those two on that single key would let the transcript
    // swallow the historical turn — one shared key is inside coincidence range
    // for a claim as strong as "the transcript reaches past the snapshot head".
    const transcript = [
      transcriptMessage('disk-7', 'plan it', { role: 'user', timestamp: 70 }),
      transcriptMessage('disk-8', 'again', { role: 'user', timestamp: 80 }),
      transcriptMessage('disk-9', 'sure', { timestamp: 90 })
    ]
    const hydrated = [rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 })]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'disk-7',
      'disk-8',
      'disk-9'
    ])
  })

  it('still trusts a corroborated older reach, where more than one position agrees', () => {
    // Same negative-offset shape as above, but now two adjacent positions
    // agree — that is evidence, not coincidence, so the collapse stands.
    const transcript = [
      transcriptMessage('disk-7', 'again', { role: 'user', timestamp: 70 }),
      transcriptMessage('disk-8', 'sure', { timestamp: 80 }),
      transcriptMessage('disk-9', 'later', { timestamp: 90 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 70 }),
      rpcMessage('omp-rpc-history-1', 'sure', { timestamp: 80 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['disk-7', 'disk-8', 'disk-9'])
  })

  it('orders a hydrated window that is newer than the transcript AFTER it', () => {
    // A capped snapshot can be the newer window: the transcript read lags on
    // disk while the drain reached records it has never seen. Nothing aligns,
    // so the two windows' own clocks decide — putting the snapshot first would
    // both break chronology and hand the status tail the wrong record.
    const transcript = [
      transcriptMessage('disk-1', 'older window a', { timestamp: 1_700 }),
      transcriptMessage('disk-2', 'older window b', { timestamp: 2_000 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'newer window a', { timestamp: 2_001 }),
      rpcMessage('omp-rpc-history-1', 'newer window b', { timestamp: 4_000 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'disk-1',
      'disk-2',
      'omp-rpc-history-0',
      'omp-rpc-history-1'
    ])
  })

  it('keeps an unaligned hydrated window ahead of the transcript when it is the older one', () => {
    const transcript = [transcriptMessage('disk-9', 'recent', { timestamp: 9_000 })]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'ancient a', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'ancient b', { timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'omp-rpc-history-1',
      'disk-9'
    ])
  })

  it('places a snapshot-only turn inside the span its neighbours pin down', () => {
    // A decoder disagreement in the middle of one shared span: the a/c records
    // are corroborated on both content AND clock, so they pin the span, and the
    // snapshot-only 'b' belongs INSIDE it. Ordering the whole fragment ahead of
    // the transcript would render 'b' before the earlier 'a'.
    const transcript = [
      transcriptMessage('disk-1', 'a', { timestamp: 10 }),
      transcriptMessage('disk-2', 'x', { timestamp: 20 }),
      transcriptMessage('disk-3', 'c', { timestamp: 30 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'b', { timestamp: 20 }),
      rpcMessage('omp-rpc-history-2', 'c', { timestamp: 30 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'disk-1',
      'disk-2',
      'omp-rpc-history-1',
      'disk-3'
    ])
  })
})

describe('mergeOmpRpcHydratedHistory clock identity', () => {
  it('keeps the older repeat when a retained snapshot predates a grown transcript tail', () => {
    // Two identical hydrated turns (@10, @20) against three identical
    // transcript turns (@20, @30, @40). A longest-content-overlap alignment
    // reads the snapshot as sitting wholly inside the transcript window and
    // retires the @10 turn; the clocks say only the @20 pair is one record.
    const transcript = [
      transcriptMessage('disk-2', 'again', { role: 'user', timestamp: 20 }),
      transcriptMessage('disk-3', 'again', { role: 'user', timestamp: 30 }),
      transcriptMessage('disk-4', 'again', { role: 'user', timestamp: 40 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'again', { role: 'user', timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'again', { role: 'user', timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'disk-2',
      'disk-3',
      'disk-4'
    ])
  })

  it('collapses nothing when the two windows do not overlap in time at all', () => {
    // The windows share two texts ('a', 'b') but their clocks are a whole
    // window apart, so those texts are LATER repetitions of the same prompts,
    // not the same records. A shared-key count would subtract them anyway.
    const transcript = [
      transcriptMessage('disk-1', 'old', { role: 'user', timestamp: 10 }),
      transcriptMessage('disk-2', 'a', { role: 'user', timestamp: 20 }),
      transcriptMessage('disk-3', 'x', { role: 'user', timestamp: 30 }),
      transcriptMessage('disk-4', 'b', { role: 'user', timestamp: 40 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { role: 'user', timestamp: 50 }),
      rpcMessage('omp-rpc-history-1', 'b', { role: 'user', timestamp: 60 }),
      rpcMessage('omp-rpc-history-2', 'new', { role: 'user', timestamp: 70 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'disk-1',
      'disk-2',
      'disk-3',
      'disk-4',
      'omp-rpc-history-0',
      'omp-rpc-history-1',
      'omp-rpc-history-2'
    ])
  })

  it('pairs on the message clock, not the transcript envelope write time', () => {
    // The envelope is stamped when the record is persisted and runs seconds
    // behind the message it wraps, which is all a wire record carries. Keying
    // identity on the render clock would duplicate every turn on reconnect.
    const transcript = [
      transcriptMessage('disk-1', 'shared', { timestamp: 20_000, originTimestamp: 1_000 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'shared', { timestamp: 1_000, originTimestamp: 1_000 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['disk-1'])
  })

  it('returns the transcript array by identity when the snapshot adds nothing new', () => {
    // The memoized consumers downstream key off this reference, so a snapshot
    // that is wholly accounted for must not churn it.
    const transcript = [transcriptMessage('disk-1', 'shared', { timestamp: 10 })]
    const hydrated = [rpcMessage('omp-rpc-history-0', 'shared', { timestamp: 10 })]

    expect(mergeOmpRpcHydratedHistory(transcript, hydrated)).toBe(transcript)
  })

  it('falls back to turn content when neither window carries a clock', () => {
    // Nothing to place records by, so multiplicity is the only evidence left:
    // the shared turn collapses and the snapshot-only turn stays, ahead of the
    // transcript because the read is a bounded tail and the drain is not.
    const transcript = [
      transcriptMessage('disk-1', 'shared', { timestamp: null }),
      transcriptMessage('disk-2', 'local only', { timestamp: null })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'older', { timestamp: null }),
      rpcMessage('omp-rpc-history-1', 'shared', { timestamp: null })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-1', 'disk-2'])
  })
})

describe('mergeOmpRpcHydratedHistory non-monotonic clocks', () => {
  it('keeps a queued turn whose clock predates the record before it in logical order', () => {
    // OMP appends a steer that was queued while a turn ran, so the snapshot's
    // RECORD order is the logical one while its clocks step backwards. Walking
    // the two windows by clock would emit the steer twice and hoist it ahead of
    // the tool result it actually followed.
    const transcript = [
      transcriptMessage('disk-steer', 'steer me', { role: 'user', timestamp: 20 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'starting', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'tool finished', { timestamp: 30 }),
      rpcMessage('omp-rpc-history-2', 'steer me', { role: 'user', timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'omp-rpc-history-1',
      'disk-steer'
    ])
  })

  it('reconciles same-instant tool results by tool identity, not output text alone', () => {
    // Two results at the same millisecond with byte-identical output: only
    // `toolCallId`/`isError` tell them apart, and the turn content key carries
    // neither. Pairing the transcript's copy with the wrong one would drop the
    // failure and render the survivor twice.
    const failedResult = rpcMessage('omp-rpc-history-0', '', {
      role: 'tool',
      timestamp: 40,
      blocks: [{ type: 'tool-result', output: 'done', isError: true, toolCallId: 'call-a' }]
    })
    const okResult = rpcMessage('omp-rpc-history-1', '', {
      role: 'tool',
      timestamp: 40,
      blocks: [{ type: 'tool-result', output: 'done', toolCallId: 'call-b' }]
    })
    const transcript = [
      transcriptMessage('disk-ok', '', {
        role: 'tool',
        timestamp: 40,
        blocks: [{ type: 'tool-result', output: 'done', toolCallId: 'call-b' }]
      })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, [failedResult, okResult])

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-ok'])
    expect(merged[0]?.blocks).toEqual([
      { type: 'tool-result', output: 'done', isError: true, toolCallId: 'call-a' }
    ])
  })
})

describe('mergeOmpRpcHydratedHistory render clock', () => {
  it('survives the list re-sort, which reads the rendered clock', () => {
    // The list re-sorts defensively (native-chat-message-grouping.ts) on
    // `timestamp`, which the two sources stamp from different clocks: a
    // transcript envelope's write time runs behind the message it wraps. The
    // snapshot-only turn was queued during the first reply, so its own clock
    // sorts it ahead of a record it must follow.
    const transcript = [
      transcriptMessage('disk-a', 'a', { timestamp: 30_000, originTimestamp: 10_000 }),
      transcriptMessage('disk-c', 'c', { timestamp: 50_000, originTimestamp: 30_000 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { timestamp: 10_000, originTimestamp: 10_000 }),
      rpcMessage('omp-rpc-history-1', 'b', { timestamp: 20_000, originTimestamp: 20_000 }),
      rpcMessage('omp-rpc-history-2', 'c', { timestamp: 30_000, originTimestamp: 30_000 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['disk-a', 'omp-rpc-history-1', 'disk-c'])
    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
      'disk-a',
      'omp-rpc-history-1',
      'disk-c'
    ])
    // The agent's own clock is the identity clock; only the render clock moves.
    expect(merged[1]?.originTimestamp).toBe(20_000)
  })

  it('never sorts a snapshot-only run ahead of the record it follows', () => {
    // XLR-012: two transcript records can share a clock — upstream stamps
    // entries at millisecond resolution — so the span between them holds no
    // position. The repair must still not answer that by stamping the run
    // BELOW both anchors, which sorts a mid-conversation record to the head.
    const transcript = [
      transcriptMessage('disk-a', 'a', { timestamp: 100 }),
      transcriptMessage('disk-c', 'c', { timestamp: 100 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { timestamp: 100 }),
      rpcMessage('omp-rpc-history-1', 'b', { timestamp: 100 }),
      rpcMessage('omp-rpc-history-2', 'c', { timestamp: 100 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['disk-a', 'omp-rpc-history-1', 'disk-c'])
    const ordered = orderNativeChatMessages(merged).map((message) => message.id)
    expect(ordered).toEqual(['disk-a', 'omp-rpc-history-1', 'disk-c'])
  })

  it('never moves the repaired anchor past the record already before it', () => {
    // XLR-027: the zero-width span between two same-clock transcript records
    // leaves no value that sorts strictly between them (and the list breaks a
    // tie by id, not by record order), so the repair has to borrow room below
    // the lower anchor. Stepping down by whole units crossed the record BEFORE
    // that anchor and rendered mid-conversation history at the head — the move
    // has to stay inside the gap the anchor already owns.
    const transcript = [
      transcriptMessage('disk-z', 'z', { timestamp: 99 }),
      transcriptMessage('disk-a', 'a', { timestamp: 100 }),
      transcriptMessage('disk-c', 'c', { timestamp: 100 })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'z', { timestamp: 99 }),
      rpcMessage('omp-rpc-history-1', 'a', { timestamp: 100 }),
      rpcMessage('omp-rpc-history-2', 'b', { timestamp: 100 }),
      rpcMessage('omp-rpc-history-3', 'c', { timestamp: 100 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
      'disk-z',
      'disk-a',
      'omp-rpc-history-2',
      'disk-c'
    ])
    // The record the repair has no business touching keeps its own clock.
    expect(merged.find((message) => message.id === 'disk-z')?.timestamp).toBe(99)
  })

  it('makes room for every gap in a same-clock run, not just the first (XLR-R5-003)', () => {
    // XLR-R5-003 (cross-lab review): the zero-width-span repair read the record
    // immediately above the upper anchor as its ceiling, even when that record
    // was itself an unrepaired hydrated one at the same clock. The first gap
    // then found "no room" and both anchors kept the shared clock, so the
    // defensive timestamp/id sort rendered the walk order A,B,C,D,E as
    // A,C,B,D,E — hydrated history reordered after a reconnect.
    const stamped = 500
    const transcript = [
      transcriptMessage('disk-a', 'a', { timestamp: stamped }),
      transcriptMessage('disk-c', 'c', { timestamp: stamped }),
      transcriptMessage('disk-e', 'e', { timestamp: stamped })
    ]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { timestamp: stamped }),
      rpcMessage('omp-rpc-history-1', 'b', { timestamp: stamped }),
      rpcMessage('omp-rpc-history-2', 'c', { timestamp: stamped }),
      rpcMessage('omp-rpc-history-3', 'd', { timestamp: stamped }),
      rpcMessage('omp-rpc-history-4', 'e', { timestamp: stamped })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual([
      'disk-a',
      'omp-rpc-history-1',
      'disk-c',
      'omp-rpc-history-3',
      'disk-e'
    ])
    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
      'disk-a',
      'omp-rpc-history-1',
      'disk-c',
      'omp-rpc-history-3',
      'disk-e'
    ])
    // Raise-only (XLR-R4-001): no transcript record may be restamped below the
    // clock a pending echo is matched against.
    for (const message of merged) {
      expect(message.timestamp).toBeGreaterThanOrEqual(stamped)
    }
    // And the borrow stays inside the millisecond the anchor already owned.
    for (const message of merged) {
      expect(message.timestamp).toBeLessThan(stamped + 1)
    }
  })

  it('leaves an unflushed tail on its own clock when that already sorts last', () => {
    // Restamping is a repair, not a policy: a snapshot tail whose clock already
    // sorts past the transcript keeps the time OMP gave it.
    const transcript = [transcriptMessage('disk-a', 'a', { timestamp: 10_000 })]
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'a', { timestamp: 10_000 }),
      rpcMessage('omp-rpc-history-1', 'b', { timestamp: 40_000 })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => [message.id, message.timestamp])).toEqual([
      ['disk-a', 10_000],
      ['omp-rpc-history-1', 40_000]
    ])
  })
})

describe('mergeOmpRpcHydratedHistory transcript-free hydration', () => {
  it('holds OMP record order against the list re-sort when there is no transcript yet', () => {
    // Reconnect before the session file is flushed: the snapshot is the whole
    // list, and its clocks step backwards over a turn queued during a reply.
    // Handing it back untouched lets the list's timestamp sort undo OMP's
    // record order.
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'starting', { timestamp: 10 }),
      rpcMessage('omp-rpc-history-1', 'tool finished', { timestamp: 30 }),
      rpcMessage('omp-rpc-history-2', 'steer me', { role: 'user', timestamp: 20 })
    ]

    const merged = mergeOmpRpcHydratedHistory([], hydrated)

    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'omp-rpc-history-1',
      'omp-rpc-history-2'
    ])
    // A repair, not a reset: the run keeps its own earliest clock as the base
    // rather than falling back to the epoch.
    expect(merged.every((message) => (message.timestamp ?? 0) >= 10)).toBe(true)
    expect(merged.map((message) => message.originTimestamp)).toEqual([
      undefined,
      undefined,
      undefined
    ])
  })

  // XLR-037 (cross-lab review): with no upper anchor the repair used to hand
  // every record the run's own earliest clock, so the list re-sort fell through
  // to its id tie-break — which is lexical, and positional ids are unpadded, so
  // twelve records rendered as 0, 1, 10, 11, 2 instead of OMP record order.
  it('gives every record of an unbounded run its own clock, not one shared base', () => {
    const hydrated = Array.from({ length: 12 }, (_, index) =>
      rpcMessage(`omp-rpc-history-${index}`, `record ${index}`, {
        // One backward step is all it takes to send the whole run through the
        // repair path.
        timestamp: index === 5 ? 40 : 100 + index
      })
    )

    const merged = mergeOmpRpcHydratedHistory([], hydrated)

    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual(
      hydrated.map((message) => message.id)
    )
    expect(new Set(merged.map((message) => message.timestamp)).size).toBe(hydrated.length)
    expect(merged.every((message) => (message.timestamp ?? 0) >= 40)).toBe(true)
  })

  // XLR-R3-004 (cross-lab review, round 3): RPC ownership exposes the composer
  // before hydration lands, so a prompt can be sent against an empty list — an
  // optimistic entry with no boundary message, reconciled by comparing the
  // rendered clock against `sentAt`. Restamping the whole run from its earliest
  // clock moved that just-delivered prompt decades before it was sent, so the
  // pending entry never matched it and the pane rendered both.
  it('leaves a newly delivered record on its own clock when older ones invert', () => {
    const sentAt = 1_700_000_000_000
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'older reply', { timestamp: 30 }),
      rpcMessage('omp-rpc-history-1', 'queued steer', { role: 'user', timestamp: 20 }),
      rpcMessage('omp-rpc-history-2', 'just sent', { role: 'user', timestamp: sentAt })
    ]

    const merged = mergeOmpRpcHydratedHistory([], hydrated)

    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
      'omp-rpc-history-0',
      'omp-rpc-history-1',
      'omp-rpc-history-2'
    ])
    // The delivered prompt keeps a clock the pending matcher can still see.
    expect(merged.at(-1)?.timestamp).toBe(sentAt)
    // Only the record that actually broke the order is repaired.
    expect(merged.map((message) => message.timestamp)).toEqual([30, 31, sentAt])
  })
})

describe('mergeOmpRpcHydratedHistory exact content identity', () => {
  it('does not conflate same-clock turns that differ only in case or spacing', () => {
    // Both sources decode the same `AgentMessage` through the same omp decoder,
    // so a shared record's text matches byte for byte. Anchoring on the
    // case-folded key instead pairs the transcript's copy with the wrong
    // hydrated record and drops the older turn.
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'go', { role: 'user', timestamp: 100 }),
      rpcMessage('omp-rpc-history-1', 'GO', { role: 'user', timestamp: 100 })
    ]
    const transcript = [transcriptMessage('disk-go', 'GO', { role: 'user', timestamp: 100 })]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(merged.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'disk-go'])
    expect(
      orderNativeChatMessages(merged).map((message) =>
        message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
      )
    ).toEqual(['go', 'GO'])
  })
})

describe('mergeOmpRpcHydratedHistory pending-send reconciliation', () => {
  // XLR-R4-001 (cross-lab review): the zero-width-span repair used to make room
  // by moving the LOWER transcript anchor DOWN, and on the first prompt of a
  // session that anchor is the user row the optimistic echo is waiting for. An
  // echo issued with no boundary message is recognized only by
  // `timestamp >= sentAt` (native-chat-pending-occurrence.ts), so a user row
  // restamped below its own persisted clock is never matched and the prompt
  // renders twice — once as the transcript turn, once as the queued bubble.
  it('never restamps a persisted user row below its own clock (XLR-R4-001)', () => {
    const sentAt = 1_000
    const transcript = [
      transcriptMessage('disk-user', 'run tests', { role: 'user', timestamp: sentAt }),
      transcriptMessage('disk-reply', 'tests pass', { timestamp: sentAt })
    ]
    // The unflushed middle record is what forces the repair: it has to sort
    // between two transcript records that share one clock.
    const hydrated = [
      rpcMessage('omp-rpc-history-0', 'run tests', { role: 'user', timestamp: sentAt }),
      rpcMessage('omp-rpc-history-1', 'checking', { timestamp: sentAt }),
      rpcMessage('omp-rpc-history-2', 'tests pass', { timestamp: sentAt })
    ]

    const merged = mergeOmpRpcHydratedHistory(transcript, hydrated)

    expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
      'disk-user',
      'omp-rpc-history-1',
      'disk-reply'
    ])
    expect(merged.find((message) => message.id === 'disk-user')?.timestamp).toBe(sentAt)
    // The invariant, stated as the consumer reads it: the echo of that prompt
    // is retracted by the merged list.
    const pending = [
      { id: 'p1', text: 'run tests', sentAt, afterMessageId: null, afterMessageTimestamp: null }
    ]
    expect(prunePendingSends(pending, merged)).toEqual([])
  })
})
