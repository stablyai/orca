import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_PROVIDER_CLOSED
} from './structured-agent-session-dispatch-rejection'
import { latestStructuredAgentSessionRequest } from './structured-agent-session-latest-request'
import { projectStructuredAgentSessionStatusSummary } from './structured-agent-session-projection'

const START_FAILURE = 'Claude is not signed in.'

function userEntry(clientMessageId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
  }
}

function turn(
  turnId: string,
  sequence: number,
  fields: Omit<AgentJournalTurnLifecycle, 'turnId'>
): AgentJournalRenderItem {
  return {
    itemId: `codex:turn:${turnId}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId, ...fields }
  }
}

function sent(
  clientMessageId: string,
  fields: Partial<AgentJournalSubmission> & Pick<AgentJournalSubmission, 'dispatchState'>
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: 20,
    handoverRecorded: true,
    ...fields
  }
}

const rejected = (clientMessageId: string, reason: string, handedOverAt?: number) =>
  sent(clientMessageId, {
    dispatchState: 'rejected',
    reason,
    ...(handedOverAt !== undefined ? { handedOverAt } : {})
  })

type Row = {
  name: string
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  fence?: number
  outcome: 'success' | 'failure' | 'cancellation' | null
  listed: boolean
}

const ROWS: Row[] = [
  {
    name: 'a send the agent start refused',
    items: [userEntry('m1', 1)],
    submissions: [rejected('m1', START_FAILURE)],
    outcome: 'failure',
    listed: true
  },
  {
    name: 'a send the user withdrew (no verdict)',
    items: [userEntry('m1', 1)],
    submissions: [rejected('m1', DISPATCH_REJECTED_CANCELLED)],
    outcome: null,
    listed: false
  },
  {
    name: 'a send still queued when the host restarted (no verdict)',
    items: [userEntry('m1', 1)],
    submissions: [rejected('m1', DISPATCH_REJECTED_HOST_RESTARTED)],
    outcome: null,
    listed: false
  },
  {
    name: 'a send still queued when the provider closed (no verdict)',
    items: [userEntry('m1', 1)],
    submissions: [rejected('m1', DISPATCH_REJECTED_PROVIDER_CLOSED)],
    outcome: null,
    listed: false
  },
  {
    name: 'a send crash recovery left unknown',
    items: [userEntry('m1', 1)],
    submissions: [sent('m1', { dispatchState: 'unknown', recovered: true })],
    outcome: null,
    listed: false
  },
  {
    name: 'a send pending at an older fence',
    items: [userEntry('m1', 1)],
    submissions: [sent('m1', { dispatchState: 'pending', handedOverAt: 11, resolvedAt: null })],
    fence: 2,
    outcome: null,
    listed: false
  },
  {
    name: 'a turn that succeeded, then a send the start refused',
    items: [
      userEntry('m1', 1),
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 15 }),
      userEntry('m2', 3)
    ],
    submissions: [sent('m1', { dispatchState: 'accepted' }), rejected('m2', START_FAILURE)],
    outcome: 'failure',
    listed: true
  },
  {
    name: 'a refused send, then a turn that succeeded',
    items: [
      userEntry('m1', 1),
      userEntry('m2', 2),
      turn('t2', 3, { state: 'completed', outcome: 'success', completedAt: 40 })
    ],
    submissions: [rejected('m1', START_FAILURE), sent('m2', { dispatchState: 'accepted' })],
    outcome: 'success',
    listed: true
  },
  {
    name: 'a steer the provider refused inside a turn that then succeeded',
    items: [
      userEntry('m1', 1),
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 50 }),
      userEntry('steer', 3)
    ],
    submissions: [
      sent('m1', { dispatchState: 'accepted' }),
      rejected('steer', 'no active turn to steer', 30)
    ],
    outcome: 'success',
    listed: true
  },
  {
    name: 'a user message the provider journaled itself (history, an older host)',
    items: [
      {
        itemId: 'codex:thread-1:turn-1:0',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'from history' }] }
      }
    ],
    submissions: [],
    outcome: null,
    listed: true
  },
  {
    name: 'a goal and nothing else yet',
    items: [
      {
        itemId: 'codex:goal-entry',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          sentAs: 'goal',
          blocks: [{ type: 'text', text: 'ship it' }]
        }
      }
    ],
    submissions: [],
    outcome: null,
    listed: true
  }
]

describe('the latest request and its verdict', () => {
  it.each(ROWS)('$name', ({ items, submissions, fence, outcome, listed }) => {
    expect(latestStructuredAgentSessionRequest(items, submissions)?.outcome ?? null).toBe(outcome)
    const summary = projectStructuredAgentSessionStatusSummary(items, submissions, fence)
    expect(summary.status !== null).toBe(listed)
    if (listed && summary.status === 'idle') {
      expect(summary.turnOutcome ?? null).toBe(outcome)
    }
  })

  it('dates an idle session by the refusal it reports, not by the older turn', () => {
    const items = [
      userEntry('m1', 1),
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 15 }),
      userEntry('m2', 3)
    ]
    const submissions = [sent('m1', { dispatchState: 'accepted' }), rejected('m2', START_FAILURE)]
    expect(projectStructuredAgentSessionStatusSummary(items, submissions)).toMatchObject({
      status: 'idle',
      turnOutcome: 'failure',
      statusStartedAt: 20
    })
  })
})
