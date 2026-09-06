// XLR-R6-007: the RPC-history aligner walks RECORD order, so the list it is
// handed must be in record order — not the clock-and-id sort the assembler
// emits. Same-instant omp records carry random uuids, so that sort can put a
// later record ahead of an earlier one and the greedy cursor then emits the
// earlier one twice.

import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { compareMessages } from './native-chat-session-assembler'
import { mergeOmpRpcHydratedHistory } from './native-chat-rpc-history-merge'
import { orderNativeChatMessagesByRecord } from './use-native-chat-assembled-messages'

const SHARED_CLOCK = 1_700_000_000_000

function transcriptRecord(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: SHARED_CLOCK,
    originTimestamp: SHARED_CLOCK,
    source: 'transcript'
  }
}

function hydratedRecord(index: number, text: string): NativeChatMessage {
  return {
    id: `omp-rpc-history-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: SHARED_CLOCK,
    originTimestamp: SHARED_CLOCK,
    source: 'rpc'
  }
}

function texts(messages: readonly NativeChatMessage[]): string[] {
  return messages.map((message) =>
    message.blocks[0]?.type === 'text' ? message.blocks[0].text : ''
  )
}

describe('record-order hydration alignment', () => {
  // Ids chosen so the assembler's id tie-break reorders record order A,B,C to
  // B,C,A: same timestamp, so `compareMessages` falls through to `id`.
  const recordOrder = [
    transcriptRecord('m-c-1', 'A'),
    transcriptRecord('m-a-2', 'B'),
    transcriptRecord('m-b-3', 'C')
  ]
  const hydrated = [hydratedRecord(0, 'A'), hydratedRecord(1, 'B'), hydratedRecord(2, 'C')]

  it('the assembler sort really does disturb record order for same-clock records', () => {
    expect(texts([...recordOrder].sort(compareMessages))).toEqual(['B', 'C', 'A'])
  })

  it('duplicates a real turn when the aligner is handed the sorted list', () => {
    const sorted = [...recordOrder].sort(compareMessages)
    expect(texts(mergeOmpRpcHydratedHistory(sorted, hydrated))).toEqual(['A', 'B', 'C', 'A'])
  })

  it('emits each turn once when record order is restored first', () => {
    const sorted = [...recordOrder].sort(compareMessages)
    const restored = orderNativeChatMessagesByRecord(sorted, recordOrder)
    expect(texts(restored)).toEqual(['A', 'B', 'C'])
    expect(texts(mergeOmpRpcHydratedHistory(restored, hydrated))).toEqual(['A', 'B', 'C'])
  })

  it('returns the input by identity when the order already agrees', () => {
    expect(orderNativeChatMessagesByRecord(recordOrder, recordOrder)).toBe(recordOrder)
  })

  it('keeps a record the transcript list no longer names at the tail', () => {
    const stray = transcriptRecord('m-z-9', 'stray')
    const restored = orderNativeChatMessagesByRecord([stray, ...recordOrder], recordOrder)
    expect(texts(restored)).toEqual(['A', 'B', 'C', 'stray'])
  })
})
