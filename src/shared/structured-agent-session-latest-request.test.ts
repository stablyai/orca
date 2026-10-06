import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import {
  AGENT_SESSION_FAILURE_KINDS,
  agentSessionFailureFact,
  isSubmissionRejectionKind
} from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_NOT_DELIVERED,
  DISPATCH_REJECTED_PROVIDER_CLOSED,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import {
  hasStructuredAgentSessionRequest,
  latestStructuredAgentSessionRequest
} from './structured-agent-session-latest-request'
import {
  projectStructuredAgentSessionStatusState,
  projectStructuredAgentSessionStatusSummary
} from './structured-agent-session-projection'

const START_FAILURE = 'Claude is not signed in.'

/** `intoTurn` names the turn the message's handover delivered it into — a steer. */
function userEntry(
  clientMessageId: string,
  sequence: number,
  intoTurn?: string
): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    turnScope: intoTurn
      ? { kind: 'turn', turnItemId: `codex:turn:${intoTurn}` }
      : { kind: 'thread' }
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

/** Rejected with a typed fact, as the host writes it. */
const rejectedWith = (
  clientMessageId: string,
  fact: Parameters<typeof agentSessionFailureWords>[0],
  resolvedAt = 20
) =>
  sent(clientMessageId, {
    dispatchState: 'rejected',
    resolvedAt,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' })
  })

const HOOK_BLOCKED = agentSessionFailureFact('hookBlocked', {
  detail: { text: 'No secrets in prompts.', audience: 'person' }
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
  // Nothing failed: the person's own hook refused it, and the chat is idle. Drawn where it was
  // rejected (after the turn's end), it is still not the news; the turn it was blocked in is.
  {
    name: 'a steer a Codex hook blocked, after the turn it joined completed (the turn, not Failed)',
    items: [
      userEntry('m1', 1),
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 15 }),
      userEntry('m2', 3)
    ],
    submissions: [sent('m1', { dispatchState: 'accepted' }), rejectedWith('m2', HOOK_BLOCKED, 16)],
    outcome: 'success',
    listed: true
  },
  {
    name: 'a first message a Codex hook blocked, with the turn it opened (the turn, not Failed)',
    items: [
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 15 }),
      userEntry('m1', 3)
    ],
    submissions: [rejectedWith('m1', HOOK_BLOCKED, 16)],
    outcome: 'success',
    listed: true
  },
  // Its tries ran out: it reads Failed, as before.
  {
    name: 'a start refused before it ran, its tries spent (Failed)',
    items: [userEntry('m1', 1)],
    submissions: [rejectedWith('m1', { kind: 'accountSwitchInProgress' })],
    outcome: 'failure',
    listed: true
  },
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
    name: 'a send crash recovery found the provider never received (no verdict)',
    items: [userEntry('m1', 1)],
    submissions: [
      sent('m1', {
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_NOT_DELIVERED,
        recovered: true
      })
    ],
    outcome: null,
    listed: false
  },
  {
    name: 'a turn that succeeded, then a send crash recovery found the provider never received',
    items: [
      userEntry('m1', 1),
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 15 }),
      userEntry('m2', 3)
    ],
    submissions: [
      sent('m1', { dispatchState: 'accepted' }),
      sent('m2', {
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_NOT_DELIVERED,
        recovered: true
      })
    ],
    outcome: 'success',
    listed: true
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
    // It waited while m2 went first; failing for good moves it to its refusal row, after t2.
    name: 'a send whose start failed for good after a later turn succeeded',
    items: [
      userEntry('m2', 2),
      turn('t2', 3, { state: 'completed', outcome: 'success', completedAt: 40 }),
      userEntry('m1', 4)
    ],
    submissions: [
      sent('m1', { dispatchState: 'rejected', reason: START_FAILURE, resolvedAt: 50 }),
      sent('m2', { dispatchState: 'accepted' })
    ],
    outcome: 'failure',
    listed: true
  },
  {
    name: 'a send still waiting for its next start that failed again after a later turn succeeded',
    items: [
      userEntry('m1', 1),
      userEntry('m2', 2),
      turn('t2', 3, { state: 'completed', outcome: 'success', completedAt: 40 })
    ],
    submissions: [
      sent('m1', {
        dispatchState: 'pending',
        resolvedAt: null,
        startRetry: {
          attempts: 2,
          reason: START_FAILURE,
          rejection: { kind: 'accountSwitchInProgress' },
          failedAt: 50,
          nextAttemptAt: 110
        }
      }),
      sent('m2', { dispatchState: 'accepted' })
    ],
    outcome: 'success',
    listed: true
  },
  {
    name: 'a later turn still running after an earlier send failed',
    items: [userEntry('m1', 1), userEntry('m2', 2), turn('t2', 3, { state: 'running' })],
    submissions: [
      sent('m1', { dispatchState: 'rejected', reason: START_FAILURE, resolvedAt: 50 }),
      sent('m2', { dispatchState: 'accepted' })
    ],
    outcome: null,
    listed: true
  },
  {
    name: 'a steer the provider refused inside a turn that then succeeded',
    items: [
      userEntry('m1', 1),
      turn('t1', 2, { state: 'completed', outcome: 'success', completedAt: 50 }),
      userEntry('steer', 3, 't1')
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

describe('the sidebar verdict agrees with the rejection classifier', () => {
  // A sentence as the reason, so only the typed fact can make a kind read as no verdict.
  // A hook's block is the one exception, pinned below.
  const typed = AGENT_SESSION_FAILURE_KINDS.filter(
    (kind) => isSubmissionRejectionKind(kind) && kind !== 'hookBlocked'
  ).map((kind) => ({
    name: `typed ${kind}`,
    submission: sent('m1', {
      dispatchState: 'rejected',
      reason: 'The message was not sent.',
      rejection: { kind }
    })
  }))
  const legacy = [
    DISPATCH_REJECTED_CANCELLED,
    DISPATCH_REJECTED_QUEUE_FULL,
    DISPATCH_REJECTED_CODEX_QUEUE_FULL,
    DISPATCH_REJECTED_HOST_RESTARTED,
    DISPATCH_REJECTED_PROVIDER_CLOSED,
    DISPATCH_REJECTED_NOT_DELIVERED,
    DISPATCH_REJECTED_WRITE_FAILED,
    `${DISPATCH_REJECTED_WRITE_FAILED}: broken pipe`
  ].map((reason) => ({ name: `legacy ${reason}`, submission: rejected('m1', reason) }))
  const unknownKind = {
    name: 'a kind this build cannot place',
    submission: sent('m1', {
      dispatchState: 'rejected',
      reason: 'A newer host wrote this.',
      rejection: { kind: 'someFutureKind' }
    })
  }

  it.each([...typed, ...legacy, unknownKind])('$name', ({ submission }) => {
    const items = [userEntry('m1', 1)]
    const { verdict } = classifyDispatchRejection(submission)
    expect(latestStructuredAgentSessionRequest(items, [submission])?.outcome ?? null).toBe(verdict)
    expect(hasStructuredAgentSessionRequest(items, [submission])).toBe(verdict === 'failure')
  })

  // Returned as a card for the person to edit (a failure to the queue), but nothing broke, so it
  // is no verdict of its own: the turn it was blocked in reads instead.
  it('reads a send a hook blocked as no verdict, though the classifier calls it a failure', () => {
    const submission = rejectedWith('m1', HOOK_BLOCKED)
    expect(classifyDispatchRejection(submission).verdict).toBe('failure')
    expect(latestStructuredAgentSessionRequest([userEntry('m1', 1)], [submission])).toBeNull()
  })

  const failedNobody = new Set([
    'typed notDelivered',
    'typed cancelled',
    'typed hostRestarted',
    'typed chatClosed',
    `legacy ${DISPATCH_REJECTED_NOT_DELIVERED}`,
    `legacy ${DISPATCH_REJECTED_CANCELLED}`,
    `legacy ${DISPATCH_REJECTED_HOST_RESTARTED}`,
    `legacy ${DISPATCH_REJECTED_PROVIDER_CLOSED}`
  ])
  const failedNobodyCases = [...typed, ...legacy].filter(({ name }) => failedNobody.has(name))
  it('covers every send that failed nobody', () => {
    expect(failedNobodyCases).toHaveLength(failedNobody.size)
  })
  it.each(failedNobodyCases)(
    'gives no verdict for a send that failed nobody: $name',
    ({ submission }) => {
      expect(latestStructuredAgentSessionRequest([userEntry('m1', 1)], [submission])).toBeNull()
    }
  )
})

// A refusal sits where it was written; a turn sits where it began and ends later. Where the two
// disagreed, the one that settled later, or the one still running, is the latest.
describe('a send that failed for good while a later turn ran', () => {
  const items = (state: 'running' | 'completed') => [
    userEntry('m2', 2),
    turn(
      't2',
      3,
      state === 'running' ? { state } : { state, outcome: 'success', completedAt: 200 }
    ),
    userEntry('m1', 4)
  ]
  const submissions = [
    sent('m1', {
      dispatchState: 'rejected',
      reason: START_FAILURE,
      rejection: { kind: 'notSignedIn' },
      resolvedAt: 100
    }),
    sent('m2', { dispatchState: 'accepted' })
  ]

  it('reads the turn when it ended after the failure: Done, the failure staying on its message', () => {
    expect(latestStructuredAgentSessionRequest(items('completed'), submissions)).toMatchObject({
      kind: 'turn',
      outcome: 'success'
    })
    const state = projectStructuredAgentSessionStatusState(items('completed'), submissions)
    expect(state.summary).toMatchObject({ status: 'idle', turnOutcome: 'success' })
    expect(state.failedStarts).toEqual([agentJournalSubmissionKey('m1')])
  })

  it('reads the turn while it still runs', () => {
    expect(latestStructuredAgentSessionRequest(items('running'), submissions)).toMatchObject({
      kind: 'turn',
      turnState: 'running'
    })
  })
})
