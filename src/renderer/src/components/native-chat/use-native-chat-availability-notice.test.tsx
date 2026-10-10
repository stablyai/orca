// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionDeliveryNotices,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'

afterEach(cleanup)
describe('each agent names its own sign-in method before a send', () => {
  it.each([
    ['claude', 'Claude', 'claude auth login'],
    ['codex', 'Codex', 'codex login'],
    ['grok', 'Grok', 'grok login'],
    ['opencode', 'OpenCode', 'opencode auth login'],
    ['pi', 'Pi', '/login'],
    ['omp', 'OMP', 'Sign in to OMP.']
  ] as const)('uses %s copy without a post-send retry tail', (agent, agentLabel, command) => {
    const { result } = renderHook(() =>
      useNativeChatAvailabilityNotice({
        agent,
        agentLabel,
        unavailable: { reason: 'notSignedIn' },
        launchFailure: null,
        journalItems: []
      })
    )
    expect(result.current?.text).toContain(command)
    expect(result.current?.text).toContain(agentLabel)
    expect(result.current?.text).not.toContain('send your message again')
  })
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
      agentLabel: 'Codex',
      unavailable: { reason: 'notSignedIn', account: 'system' },
      launchFailure: null,
      journalItems: [authRow]
    })
  )
  expect(result.current).toBeNull()
  const notices = structuredAgentSessionDeliveryNotices({
    pending: [],
    agentName: 'Codex',
    startFailures: structuredAgentSessionStartFailureFacts([authRow]),
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

it.each(['launch', 'history', 'send'] as const)(
  'leaves a missing Codex explanation to its existing %s refusal',
  (surface) => {
    const refusal = {
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachFailed',
        codexInstallation: { installedVersion: null, minimumVersion: '0.136.0' }
      }
    } as const
    const row: AgentJournalRenderItem = {
      itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-1')),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'startFailed', refusal },
          { agentName: 'Codex', surface: 'row' }
        )
      }
    }
    const rejection: AgentSessionFailureFact = { kind: 'startFailed', refusal }
    const sentKey = agentJournalSubmissionKey('sent')
    const sentRow: AgentJournalRenderItem = {
      itemId: sentKey,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [] }
    }
    const { result } = renderHook(() =>
      useNativeChatAvailabilityNotice({
        agent: 'codex',
        agentLabel: 'Codex',
        unavailable: { reason: 'cliMissing' },
        launchFailure: surface === 'launch' ? refusal : null,
        journalItems: surface === 'history' ? [row] : surface === 'send' ? [sentRow] : [],
        ...(surface === 'send'
          ? {
              submissions: [
                {
                  clientMessageId: 'sent',
                  submittedAt: 1,
                  dispatchState: 'rejected' as const,
                  rejection
                }
              ],
              deliveryNotices: new Map([[sentKey, { text: 'line' }]])
            }
          : {})
      })
    )
    expect(result.current).toBeNull()
  }
)

// A signed-out Pi turns the send away before any turn: that send's own line says it.
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
        agentLabel: 'Pi',
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
