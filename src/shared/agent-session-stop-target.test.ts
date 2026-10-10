import { expect, it } from 'vitest'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { agentSessionStopTarget, agentSessionStopTargetIsLive } from './agent-session-stop-target'
import {
  agentSessionBackgroundStopTarget,
  targetedAgentSessionBackgroundTaskIds
} from './agent-session-background-stop-target'

const pending: AgentJournalSubmission = {
  clientMessageId: 'send-1',
  fence: 1,
  payloadFingerprint: 'fp',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null
}

it('follows an unanswered send into its own turn and excludes a later turn', () => {
  const target = agentSessionStopTarget(null, [pending], 1)
  if (!target) {
    throw new Error('expected target')
  }
  expect(agentSessionStopTargetIsLive(target, null, [pending], 1)).toBe(true)
  const accepted = {
    ...pending,
    dispatchState: 'accepted' as const,
    providerItemId: agentJournalItemKey({
      provider: 'codex',
      threadId: 'thread',
      turnId: 'one',
      ordinal: 0
    })
  }
  expect(agentSessionStopTargetIsLive(target, 'one', [accepted], 1)).toBe(true)
  expect(agentSessionStopTargetIsLive(target, 'two', [accepted], 1)).toBe(false)
  expect(
    agentSessionStopTargetIsLive(target, null, [{ ...pending, dispatchState: 'rejected' }], 1)
  ).toBe(false)
  expect(agentSessionStopTargetIsLive(target, 'one', [accepted], 2)).toBe(false)
})

it('never names a queued send, and a waiting send stays live whatever arrives after it', () => {
  const handedOver = { ...pending, handoverRecorded: true as const, handedOverAt: 2 }
  const queued = { ...pending, clientMessageId: 'send-2', handoverRecorded: true as const }
  expect(agentSessionStopTarget(null, [handedOver, queued], 1)).toEqual({
    kind: 'submission',
    clientMessageId: 'send-1'
  })
  expect(agentSessionStopTarget(null, [queued], 1)).toBeUndefined()
  const target = { kind: 'submission' as const, clientMessageId: 'send-1' }
  const laterSent = { ...pending, clientMessageId: 'send-3' }
  expect(agentSessionStopTargetIsLive(target, null, [handedOver, queued], 1)).toBe(true)
  expect(agentSessionStopTargetIsLive(target, null, [handedOver, laterSent], 1)).toBe(true)
})

it('uses the host turn linkage for a provider whose item identity does not carry a turn id', () => {
  const providerItemId = agentJournalItemKey({
    provider: 'legacy',
    agent: 'pi',
    sessionId: 'session',
    recordId: 'user-1'
  })
  expect(
    agentSessionStopTargetIsLive(
      { kind: 'submission', clientMessageId: 'send-1' },
      'one',
      [{ ...pending, providerItemId }],
      1,
      providerItemId
    )
  ).toBe(true)
})

it('cannot reuse an old background Stop against a new invocation with the same provider handle', () => {
  const child: AgentChildWorkView = {
    id: 'child-1',
    providerId: 'task-1',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: true,
    invocation: { invocationId: 'invocation-1', generation: 1 }
  }
  const target = agentSessionBackgroundStopTarget([child])
  expect(targetedAgentSessionBackgroundTaskIds([child], target)).toEqual(['task-1'])
  expect(
    targetedAgentSessionBackgroundTaskIds([{ ...child, membership: 'settled' }], target)
  ).toEqual([])
  expect(
    targetedAgentSessionBackgroundTaskIds(
      [{ ...child, invocation: { invocationId: 'invocation-1', generation: 2 } }],
      target
    )
  ).toEqual([])
  expect(targetedAgentSessionBackgroundTaskIds([{ ...child, id: 'child-2' }], target)).toEqual([])
})
