// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionReviewReplyReceiptMessageId } from '../../../shared/agent-session-review-reply'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  dropStructuredReviewReplyWatchers,
  noticeStructuredReviewReplyReceipt,
  watchStructuredReviewReplySettled
} from './structured-agent-session-review-reply-settled'

const RECEIPT = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: agentSessionReviewReplyReceiptMessageId('message-1')
})
const OTHER = agentJournalItemKey({ provider: 'orca', clientMessageId: 'message-1#delivery' })

function batch(change: { removed?: string[]; items?: string[] }): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: {
      cursor: { epoch: 'e', sequence: 2 },
      items: (change.items ?? []).map((itemId) => ({
        itemId,
        revision: 1,
        sequence: 2,
        observedAt: 1,
        body: { kind: 'status' as const, text: 'x' }
      })),
      removedItemIds: change.removed ?? [],
      submissions: []
    }
  }
}

afterEach(() => {
  dropStructuredReviewReplyWatchers('session-1')
  vi.useRealTimers()
})

describe("a source's watch for its chat's review-reply receipt", () => {
  it("holds the chat's read open while armed, and lets go however it ends", () => {
    vi.useFakeTimers()
    const holds = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    const hold = (index: number) => () => holds[index]!
    watchStructuredReviewReplySettled('session-1', vi.fn(), { holdRead: hold(0) })
    const dispose = watchStructuredReviewReplySettled('session-2', vi.fn(), { holdRead: hold(1) })
    watchStructuredReviewReplySettled('session-3', vi.fn(), { holdRead: hold(2) })
    watchStructuredReviewReplySettled('session-4', vi.fn(), {
      holdRead: hold(3),
      lifetimeMs: 1000
    })
    expect(holds.some((release) => release.mock.calls.length > 0)).toBe(false)

    noticeStructuredReviewReplyReceipt('session-1', batch({ removed: [RECEIPT] }))
    dispose()
    dropStructuredReviewReplyWatchers('session-3')
    vi.advanceTimersByTime(1001)

    for (const release of holds) {
      expect(release).toHaveBeenCalledOnce()
    }
  })

  it('runs once, on a written line or a tombstone in a live batch, and only for that chat', () => {
    const settled = vi.fn()
    watchStructuredReviewReplySettled('session-1', settled)

    noticeStructuredReviewReplyReceipt('session-2', batch({ removed: [RECEIPT] }))
    noticeStructuredReviewReplyReceipt('session-1', batch({ removed: [OTHER] }))
    expect(settled).not.toHaveBeenCalled()

    noticeStructuredReviewReplyReceipt('session-1', batch({ removed: [RECEIPT] }))
    noticeStructuredReviewReplyReceipt('session-1', batch({ items: [RECEIPT] }))
    expect(settled).toHaveBeenCalledOnce()

    const line = vi.fn()
    watchStructuredReviewReplySettled('session-1', line)
    noticeStructuredReviewReplyReceipt('session-1', batch({ items: [RECEIPT] }))
    expect(line).toHaveBeenCalledOnce()
  })

  it('dies when disposed, when its chat closes, or when the window passes', () => {
    vi.useFakeTimers()
    const disposed = vi.fn()
    const closed = vi.fn()
    const expired = vi.fn()
    watchStructuredReviewReplySettled('session-1', disposed)()
    watchStructuredReviewReplySettled('session-1', closed)
    dropStructuredReviewReplyWatchers('session-1')
    watchStructuredReviewReplySettled('session-1', expired, { lifetimeMs: 1000 })
    vi.advanceTimersByTime(1001)

    noticeStructuredReviewReplyReceipt('session-1', batch({ removed: [RECEIPT] }))

    expect(disposed).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    expect(expired).not.toHaveBeenCalled()
  })
})
