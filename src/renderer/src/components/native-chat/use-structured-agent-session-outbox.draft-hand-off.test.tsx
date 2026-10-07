// @vitest-environment happy-dom

// A submission's `queuedMessageId` is the only link between a queued send and what the host did
// with it: the host hands every draft off under a fresh submission id. An outbox entry the host
// handed off belongs to the host, whatever the hand-off's state, and nothing here compares a draft
// id with a submission id.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

type SentParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(cleanup)

const TARGET = { kind: 'local' } as const
const QUEUEING = { capability: 'supported', enabled: true } as const

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: 11,
    handoverRecorded: true,
    ...overrides
  }
}

const WITHDRAWN = { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED } as const

function seed(clientMessageId: string, queued: boolean): void {
  writeOutbox('session-1', [
    {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId,
        sessionId: 'session-1',
        text: 'follow-up',
        attachments: [],
        queuedAt: 1
      }),
      sentDelivery: queued ? ('queue-if-active' as const) : null,
      state: 'unconfirmed',
      lastAttemptAt: 5
    }
  ])
}

function renderOutbox() {
  type Props = { submissions: AgentJournalSubmission[] }
  const initialProps: Props = { submissions: [] }
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOutbox({
        journalItems: NO_JOURNAL_ITEMS,
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: props.submissions,
        composerScopeKey: 'scope',
        queueDelivery: QUEUEING
      }),
    { initialProps }
  )
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

describe('an outbox entry the host handed off as a queued draft', () => {
  it('lost answer, Stop, then drained under a fresh id: it leaves, and the composer gets nothing', async () => {
    seed('draft', true)
    const view = renderOutbox()
    act(() => {
      view.result.current.withdrawUnsent()
    })
    expect(view.result.current.outbox).toHaveLength(1)
    view.rerender({
      submissions: [
        submission('first', { ...WITHDRAWN, queuedMessageId: 'draft' }),
        submission('second', { queuedMessageId: 'draft' })
      ]
    })
    await waitFor(() => expect(view.result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('scope')).toBe('')
  })

  it('lost answer, then refused: the returned card carries it, with no Retry row here', async () => {
    seed('draft', true)
    const view = renderOutbox()
    // No published list yet: the link alone settles it, whichever effect runs first.
    view.rerender({
      submissions: [
        submission('first', {
          dispatchState: 'rejected',
          reason: 'The provider refused this message.',
          queuedMessageId: 'draft'
        })
      ]
    })
    await waitFor(() => expect(view.result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('scope')).toBe('')
  })

  it('a withdrawn immediate send leaves the outbox and stays in the transcript, not the composer', async () => {
    seed('plain', false)
    const view = renderOutbox()
    view.rerender({ submissions: [submission('plain', WITHDRAWN)] })
    await waitFor(() => expect(view.result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('scope')).toBe('')
  })

  it('a withdrawn hand-off is never restored, even one under the id of the entry', async () => {
    seed('draft', true)
    const view = renderOutbox()
    view.rerender({ submissions: [submission('draft', { ...WITHDRAWN, queuedMessageId: 'q' })] })
    await waitFor(() => expect(view.result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('scope')).toBe('')
  })

  it('a replayed send answered with the hand-off settles as the host holding it', async () => {
    mocks.call.mockImplementationOnce(async (_target, _method, params) => ({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: 'second',
        submission: submission('second', {
          dispatchState: 'pending',
          resolvedAt: null,
          queuedMessageId: params.envelope.clientOperationId
        })
      }
    }))
    const view = renderOutbox()
    act(() => {
      expect(view.result.current.send('follow-up')).toBe(true)
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    // Let the answer land before reading the outbox.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(view.result.current.outbox).toEqual([])
    expect(view.result.current.error).toBeNull()
    // Single-flight is free again: the next send goes out.
    expect(view.result.current.send('next')).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })

  it('a replay of a deleted card is answered spent: it leaves with no restore and no Retry', async () => {
    mocks.call.mockImplementationOnce(async (_target, _method, params) => ({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: params.envelope.clientOperationId,
        queued: { messageId: params.envelope.clientOperationId, position: 0, state: 'withdrawn' }
      }
    }))
    const view = renderOutbox()
    act(() => {
      expect(view.result.current.send('deleted on another device')).toBe(true)
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(view.result.current.outbox).toEqual([])
    expect(view.result.current.error).toBeNull()
    expect(readNativeChatDraftCache('scope')).toBe('')
    act(() => {
      expect(view.result.current.send('next')).toBe(true)
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })
})
