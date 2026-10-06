import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { AgentJournalSubmissionSchema } from './agent-session-journal-schemas'
import { latestStructuredAgentSessionRequest } from './structured-agent-session-latest-request'
import { isStructuredAgentSessionMainAgentWorking } from './structured-agent-session-main-agent-working'
import {
  isRetryingStructuredAgentSessionStart,
  structuredAgentSessionStartRetryAt
} from './structured-agent-session-start-retry'

const FAILED_AT = 1_000

// Which start is tried again is decided where it failed (see the start-failure writer's tests);
// this is only when.
describe('when a message whose agent start failed is tried again', () => {
  it('waits 15 s, 1 min and 5 min, then is done trying', () => {
    expect(
      [1, 2, 3, 4].map((attempts) => structuredAgentSessionStartRetryAt(attempts, FAILED_AT))
    ).toEqual([FAILED_AT + 15_000, FAILED_AT + 60_000, FAILED_AT + 300_000, null])
  })
})

function submission(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: 'cm_1',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    handoverRecorded: true,
    ...patch
  }
}

const RETRYING = submission({
  startRetry: {
    attempts: 1,
    reason: 'A Claude account switch is in progress.',
    rejection: { kind: 'accountSwitchInProgress' },
    failedAt: FAILED_AT,
    nextAttemptAt: FAILED_AT + 15_000
  }
})

const MESSAGE: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey('cm_1'),
  revision: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
  sequence: 1,
  observedAt: 1
}

describe('a queued message waiting out a failed start', () => {
  it('is not work in progress: nothing runs for it until its next try', () => {
    expect(isRetryingStructuredAgentSessionStart(RETRYING)).toBe(true)
    expect(isStructuredAgentSessionMainAgentWorking(null, [RETRYING])).toBe(false)
    expect(isStructuredAgentSessionMainAgentWorking(null, [submission()])).toBe(true)
  })

  // A try is booked, so it has no verdict yet: no session list reads it as failed, nor as working.
  it('leaves the session reading as it did before it was sent', () => {
    expect(latestStructuredAgentSessionRequest([MESSAGE], [RETRYING])).toBeNull()
    const earlier = submission({ clientMessageId: 'earlier', dispatchState: 'accepted' })
    const answered: AgentJournalRenderItem = {
      itemId: 'turn:t1',
      revision: 0,
      sequence: 0,
      observedAt: 0,
      body: {
        kind: 'turn',
        turnId: 't1',
        state: 'completed',
        outcome: 'success',
        startedAt: 0,
        completedAt: 500
      }
    }
    expect(
      latestStructuredAgentSessionRequest([answered, MESSAGE], [earlier, RETRYING])
    ).toMatchObject({ kind: 'turn', id: 't1', outcome: 'success' })
  })

  it('reaches a client whole, and a malformed record costs only the record', () => {
    expect(AgentJournalSubmissionSchema.parse(RETRYING)).toEqual(RETRYING)
    const damaged = AgentJournalSubmissionSchema.parse({
      ...RETRYING,
      startRetry: { attempts: 'one' }
    })
    expect(damaged).toEqual(submission())
  })
})
