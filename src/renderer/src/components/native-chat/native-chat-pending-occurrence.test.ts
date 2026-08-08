import { beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSendScope
} from './native-chat-pending'
import {
  dropNativeChatPendingOccurrences,
  type NativeChatPendingOccurrence
} from './native-chat-pending-occurrence'

const scope: NativeChatPendingSendScope = { paneKey: 'tab:leaf', agent: 'codex' }

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

describe('pending send occurrence reconciliation', () => {
  beforeEach(() => clearPendingSendCacheForTests())

  it('keeps the next identical echo after pruning an earlier occurrence', () => {
    const first = appendPendingSendCache(scope, {
      id: 'p1',
      text: 'repeat',
      sentAt: 100,
      afterMessageId: 'paged-out-boundary'
    })
    const repeated = appendPendingSendCache(scope, {
      id: 'p2',
      text: 'repeat',
      sentAt: 200,
      afterMessageId: 'paged-out-boundary'
    })
    expect(first[0]?.matchingOccurrence).toBeUndefined()
    expect(repeated[1]).toMatchObject({ matchingOccurrence: 2, matchingAfterTimestamp: 100 })

    const firstCompletedTurn = [
      message('u1', 'user', 'repeat', 150),
      message('a1', 'assistant', 'done', 160)
    ]
    const afterFirstPrune = prunePendingSends(repeated, firstCompletedTurn)

    expect(afterFirstPrune.map((entry) => entry.id)).toEqual(['p2'])
    expect(
      pendingSendsAsMessages(afterFirstPrune, firstCompletedTurn).map((entry) => entry.id)
    ).toEqual(['pending:p2'])

    const secondCompletedTurn = [
      ...firstCompletedTurn,
      message('u2', 'user', 'repeat', 250),
      message('a2', 'assistant', 'done again', 260)
    ]
    expect(pendingSendsAsMessages(afterFirstPrune, secondCompletedTurn)).toEqual([])
    expect(prunePendingSends(afterFirstPrune, secondCompletedTurn)).toEqual([])
  })
})

describe('dropNativeChatPendingOccurrences', () => {
  type Entry = NativeChatPendingOccurrence & { id: string }

  function entry(id: string, text: string, matchingOccurrence?: number): Entry {
    return { id, text, sentAt: 100, afterMessageId: null, matchingOccurrence }
  }

  it('returns the same reference when nothing is dropped', () => {
    const pending = [entry('p1', 'ping'), entry('p2', 'ping', 2)]
    expect(dropNativeChatPendingOccurrences(pending, () => false)).toBe(pending)
  })

  it('pulls a later same-key sibling down by one slot per drop', () => {
    const pending = [entry('p1', 'ping'), entry('p2', 'ping', 2), entry('p3', 'ping', 3)]
    const next = dropNativeChatPendingOccurrences(pending, (candidate) => candidate.id === 'p1')
    expect(next.map((candidate) => [candidate.id, candidate.matchingOccurrence])).toEqual([
      ['p2', 1],
      ['p3', 2]
    ])
  })

  it('counts drops per key, so two same-key drops release two slots', () => {
    const pending = [entry('p1', 'ping'), entry('p2', 'ping', 2), entry('p3', 'ping', 3)]
    const next = dropNativeChatPendingOccurrences(pending, (candidate) => candidate.id !== 'p3')
    expect(next.map((candidate) => [candidate.id, candidate.matchingOccurrence])).toEqual([
      ['p3', 1]
    ])
  })

  it('leaves another key alone, so an unrelated drop cannot retire it early', () => {
    // 'ping' holds slot 2 because a real landed turn consumed slot 1; dropping
    // 'other' frees no 'ping' slot.
    const pending = [entry('p1', 'other'), entry('p2', 'ping', 2)]
    const next = dropNativeChatPendingOccurrences(pending, (candidate) => candidate.id === 'p1')
    expect(next.map((candidate) => [candidate.id, candidate.matchingOccurrence])).toEqual([
      ['p2', 2]
    ])
  })

  it('leaves a sibling that precedes the drop untouched', () => {
    const pending = [entry('p1', 'ping', 2), entry('p2', 'ping', 3)]
    const next = dropNativeChatPendingOccurrences(pending, (candidate) => candidate.id === 'p2')
    expect(next.map((candidate) => [candidate.id, candidate.matchingOccurrence])).toEqual([
      ['p1', 2]
    ])
  })

  it('never invents an occurrence or falls below the first slot', () => {
    const pending = [entry('p1', 'ping'), entry('p2', 'ping'), entry('p3', 'ping', 1)]
    const next = dropNativeChatPendingOccurrences(pending, (candidate) => candidate.id === 'p1')
    expect(next.map((candidate) => [candidate.id, candidate.matchingOccurrence])).toEqual([
      ['p2', undefined],
      ['p3', 1]
    ])
  })
})
