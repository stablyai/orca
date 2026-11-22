import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../agent-session/failures/agent-session-failure-words'
import { latestNativeChatUsageLimitCut } from './native-chat-usage-limit-cut'

const items: AgentJournalRenderItem[] = [
  {
    itemId: 'turn',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'limited', state: 'completed', outcome: 'failure' }
  },
  {
    itemId: 'limit',
    sequence: 2,
    revision: 1,
    observedAt: 1,
    turnScope: { kind: 'turn', turnItemId: 'turn' },
    body: {
      kind: 'status',
      ...agentSessionFailureWords(
        { kind: 'usageLimitReached', usageLimit: { resetsAt: 999 } },
        { surface: 'row' }
      )
    }
  },
  {
    itemId: 'orca:mail',
    sequence: 3,
    revision: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [] }
  }
]

function refused(
  kind: 'notDelivered' | 'cancelled' | 'providerRejected',
  queuedMessageId: string | null = 'card'
): AgentJournalSubmission {
  return {
    clientMessageId: 'mail',
    ...(queuedMessageId ? { queuedMessageId } : {}),
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    ...agentSessionFailureWords({ kind, neverReachedAgent: true }, { surface: 'rejection' }),
    submittedAt: 1,
    resolvedAt: 1
  }
}

describe('latestNativeChatUsageLimitCut', () => {
  it('passes over a queued send readiness sent back', () => {
    expect(latestNativeChatUsageLimitCut(items, [refused('notDelivered')])).toEqual({
      turnItemId: 'turn',
      resetsAt: 999
    })
  })

  it('keeps a sent-back queued send a newer request for a host predating the pass-over', () => {
    expect(
      latestNativeChatUsageLimitCut(items, [refused('notDelivered')], {
        passOverSentBackQueuedSends: false
      })
    ).toBeNull()
  })

  it('treats any other later send, refused or not, as a newer request', () => {
    expect(latestNativeChatUsageLimitCut(items, [refused('providerRejected')])).toBeNull()
    expect(latestNativeChatUsageLimitCut(items, [refused('cancelled')])).toBeNull()
    expect(latestNativeChatUsageLimitCut(items, [refused('notDelivered', null)])).toBeNull()
    const answered = {
      ...refused('notDelivered'),
      answeredInTurn: { turnItemId: 'turn', via: 'start' as const }
    }
    expect(latestNativeChatUsageLimitCut(items, [answered])).toBeNull()
    expect(latestNativeChatUsageLimitCut(items, [])).toBeNull()
  })
})
