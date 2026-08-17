import { beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { countLeadingPendingTextsGluedToUserText } from './native-chat-pending-occurrence'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSendScope
} from './native-chat-pending'

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

describe('countLeadingPendingTextsGluedToUserText', () => {
  it('consumes a leading run with or without one separator per boundary', () => {
    expect(countLeadingPendingTextsGluedToUserText(['joke', 'continue'], 'jokecontinue')).toBe(2)
    expect(countLeadingPendingTextsGluedToUserText(['joke', 'continue'], 'joke continue')).toBe(2)
    expect(countLeadingPendingTextsGluedToUserText(['a', 'b', 'c'], 'ab c')).toBe(3)
  })

  it('stops at the first prompt that does not continue the row', () => {
    expect(countLeadingPendingTextsGluedToUserText(['hi'], 'history')).toBe(0)
    expect(countLeadingPendingTextsGluedToUserText(['hi', 'story'], 'hi story continued')).toBe(0)
    expect(countLeadingPendingTextsGluedToUserText(['hi', 'there friend'], 'hi there')).toBe(0)
    expect(countLeadingPendingTextsGluedToUserText(['hi', 'x'], 'hi  x')).toBe(0)
  })

  it('requires the first prompt to start the row', () => {
    expect(countLeadingPendingTextsGluedToUserText(['hi', 'there'], ' hi there')).toBe(0)
  })

  it('returns the run length, leaving later prompts to the next row', () => {
    expect(countLeadingPendingTextsGluedToUserText(['a', 'b', 'c'], 'a b')).toBe(2)
  })

  it('rejects empty inputs and empty prompts', () => {
    expect(countLeadingPendingTextsGluedToUserText([], 'anything')).toBe(0)
    expect(countLeadingPendingTextsGluedToUserText(['a'], '')).toBe(0)
    expect(countLeadingPendingTextsGluedToUserText(['a', '', 'b'], 'ab')).toBe(0)
  })
})
