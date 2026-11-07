// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { agentSessionVisibleFailureFacts } from '../../../../shared/agent-session/failures/agent-session-visible-failures'

afterEach(cleanup)

it('offers the host sign-in action before an authenticated turn can start', () => {
  const signIn = vi.fn()
  const { result, rerender } = renderHook(
    ({ signingIn }) =>
      useNativeChatAvailabilityNotice({
        agent: 'omp',
        unavailable: { reason: 'notSignedIn' },
        launchFailure: null,
        journalItems: [],
        signIn: { signingIn, signIn }
      }),
    { initialProps: { signingIn: false } }
  )
  result.current?.action?.onClick()
  expect(signIn).toHaveBeenCalledOnce()
  rerender({ signingIn: true })
  expect(result.current?.action?.disabled).toBe(true)
})

it('keeps one auth explanation while an unechoed message still reads as unsent', () => {
  const failure = {
    kind: 'notSignedIn',
    account: 'system',
    detail: { text: 'Expired session token', audience: 'person' }
  } as const
  const authRow: AgentJournalRenderItem = {
    itemId: 'codex-error',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(failure, { agentName: 'Codex', surface: 'row' })
    }
  }
  const { result } = renderHook(() =>
    useNativeChatAvailabilityNotice({
      agent: 'codex',
      unavailable: { reason: 'notSignedIn', account: 'system' },
      launchFailure: null,
      journalItems: [authRow]
    })
  )
  expect(result.current).toBeNull()
  const notices = structuredAgentSessionDeliveryNotices({
    pending: [],
    agentName: 'Codex',
    startFailures: agentSessionVisibleFailureFacts([authRow]),
    submissions: [
      {
        clientMessageId: 'send',
        fence: 1,
        payloadFingerprint: 'send',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: 'Host sign-in guidance',
        rejection: failure,
        submittedAt: 1,
        resolvedAt: 2
      }
    ]
  })
  expect([...notices.values()].map((notice) => notice.text)).toEqual(['Your message was not sent.'])
})

it("steps aside while the newest send's own line says the notice's reason", () => {
  const sent = (
    id: string,
    order: { at: number; sequence?: number },
    rejected?: 'notSignedIn' | 'providerRejected'
  ) => ({
    clientMessageId: id,
    submittedAt: order.at,
    ...(order.sequence === undefined ? {} : { submittedSequence: order.sequence }),
    dispatchState: rejected ? ('rejected' as const) : ('accepted' as const),
    ...(rejected ? { rejection: { kind: rejected } } : {})
  })
  const lines = (...ids: string[]) =>
    new Map(ids.map((id) => [agentJournalSubmissionKey(id), { text: 'line' }]))
  const rows = (...ids: string[]): AgentJournalRenderItem[] =>
    ids.map((id, index) => ({
      itemId: agentJournalSubmissionKey(id),
      revision: 1,
      sequence: index + 1,
      observedAt: index + 1,
      body: { kind: 'message', role: 'user', text: id, blocks: [] }
    }))
  const notice = (
    submissions: ReturnType<typeof sent>[],
    deliveryNotices = lines('a', 'b'),
    journalItems = rows('a', 'b')
  ) =>
    renderHook(() =>
      useNativeChatAvailabilityNotice({
        agent: 'pi',
        unavailable: { reason: 'notSignedIn' },
        launchFailure: null,
        journalItems,
        submissions,
        deliveryNotices
      })
    ).result.current
  expect(notice([sent('a', { at: 1 }, 'notSignedIn')])).toBeNull()
  expect(notice([sent('a', { at: 1 }, 'providerRejected')])?.text).toContain('/login')
  expect(notice([sent('a', { at: 1 }, 'notSignedIn'), sent('b', { at: 2 })])?.text).toContain(
    '/login'
  )
  // Its line gone (a returned card deleted, the row trimmed): the notice is the only guidance.
  expect(notice([sent('a', { at: 1 }, 'notSignedIn')], lines())?.text).toContain('/login')
  expect(notice([sent('a', { at: 1 }, 'notSignedIn')], lines('a'), rows())?.text).toContain(
    '/login'
  )
  // The host's send order decides, not a clock that moved back.
  expect(
    notice([sent('a', { at: 5, sequence: 1 }, 'notSignedIn'), sent('b', { at: 2, sequence: 2 })])
      ?.text
  ).toContain('/login')
})
