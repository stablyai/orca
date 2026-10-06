// A message whose agent start was refused: while Orca tries again it says why and that Orca will,
// and once the tries run out it says why beside its Retry.

import { describe, expect, it } from 'vitest'
import {
  isSubmissionRejectionFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from '../../../../shared/agent-session-wire-refusals'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionRejectedFailure } from '../../../../shared/structured-agent-session-outbox'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import {
  entry,
  NOT_FAILED_HERE,
  texts
} from './structured-agent-session-delivery-notices-test-fixtures'

describe('the notice on a message whose agent start failed', () => {
  function queued(
    id: string,
    startRetry?: AgentJournalSubmission['startRetry']
  ): AgentJournalSubmission {
    return {
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null,
      handoverRecorded: true,
      ...(startRetry ? { startRetry } : {})
    }
  }
  const transient = { kind: 'accountSwitchInProgress' } as const

  it('says why and that Orca tries again, with no Retry, whoever sent it', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [entry('mine', { state: 'dispatching' })],
      'Claude',
      () => {},
      [
        queued('mine', {
          attempts: 1,
          reason: 'Written by the host.',
          rejection: transient,
          failedAt: 1,
          nextAttemptAt: 15_001
        }),
        queued('orca', {
          attempts: 2,
          reason: 'Written by the host.',
          rejection: transient,
          failedAt: 1,
          nextAttemptAt: 60_001
        }),
        queued('waiting')
      ],
      [],
      NOT_FAILED_HERE
    )

    const said = 'A Claude account switch is in progress. Orca will try again shortly.'
    expect(Object.fromEntries(notices)).toEqual({
      [agentJournalSubmissionKey('mine')]: { text: said },
      [agentJournalSubmissionKey('orca')]: { text: said }
    })
  })

  function retrying(id: string, rejection: AgentSessionFailureFact): AgentJournalSubmission {
    return queued(id, {
      attempts: 1,
      reason: 'Written by the host.',
      rejection,
      failedAt: 1,
      nextAttemptAt: 15_001
    })
  }

  it.each([
    [{ kind: 'accountSwitchInProgress' }, 'A Claude account switch is in progress.'],
    [
      { kind: 'restartFailed', refusal: { code: 'execution_owner_reconciling' } },
      "Claude couldn't restart."
    ],
    [
      { kind: 'startFailed', refusal: { code: 'agent_session_operation_conflict' } },
      "Claude couldn't start."
    ],
    [
      {
        kind: 'restartFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
      },
      "Claude couldn't restart. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    ]
  ] as const)(
    'says why %j and that Orca tries again, and leaves trying again to Orca',
    (rejection, why) => {
      expect(texts([], [retrying('mine', rejection)])).toEqual({
        [agentJournalSubmissionKey('mine')]: `${why} Orca will try again shortly.`
      })
    }
  )

  // Orca tries again any start refused before spawn whose refusing site did not say only the person
  // can clear it: the account switch, or a start or restart refused with any code.
  it('never tells the person to try again while Orca will, for any start Orca tries again', () => {
    const facts = [
      { kind: 'accountSwitchInProgress' } satisfies AgentSessionFailureFact,
      ...(['startFailed', 'restartFailed'] as const).flatMap((kind) =>
        AGENT_SESSION_WIRE_REFUSAL_CODES.map((code) =>
          readWholeAgentSessionFailureFact({ kind, refusal: { code } })
        )
      )
    ].filter(
      (fact): fact is AgentSessionFailureFact =>
        fact !== undefined && isSubmissionRejectionFact(fact)
    )
    expect(facts.length).toBe(1 + 2 * AGENT_SESSION_WIRE_REFUSAL_CODES.length)
    for (const fact of facts) {
      const [text] = Object.values(texts([], [retrying('mine', fact)]))
      expect(text?.endsWith(' Orca will try again shortly.')).toBe(true)
      expect(text?.replace(' Orca will try again shortly.', '')).not.toMatch(/again|retry/i)
    }
  })

  it('keeps when to try again beside the Retry once the tries run out', () => {
    const words = agentSessionFailureWords(
      { kind: 'accountSwitchInProgress' },
      { surface: 'rejection', agentName: 'Claude' }
    )
    expect(
      texts(
        [
          entry('mine', {
            state: 'rejected',
            lastFailure: structuredAgentSessionRejectedFailure(words)
          })
        ],
        [{ ...queued('mine'), dispatchState: 'rejected', ...words }]
      )
    ).toEqual({
      [agentJournalSubmissionKey('mine')]:
        'A Claude account switch is in progress. Try again after it finishes.'
    })
  })

  it("keeps the host's sentence for a failure this build cannot read whole", () => {
    expect(
      texts(
        [],
        [
          queued('mine', {
            attempts: 1,
            reason: 'Written by a newer host.',
            rejection: { kind: 'aNewerKind' },
            failedAt: 1,
            nextAttemptAt: 15_001
          })
        ]
      )
    ).toEqual({
      [agentJournalSubmissionKey('mine')]: 'Written by a newer host. Orca will try again shortly.'
    })
  })

  // On a host that queues it again in place; elsewhere it has no Retry, so sending again is the step.
  it('offers Retry, and sign-in as the step, once a signed-out start is rejected', () => {
    const signedOut = { kind: 'notSignedIn' } as const
    const words = agentSessionFailureWords(signedOut, { surface: 'rejection', agentName: 'Claude' })
    expect(
      texts(
        [
          entry('mine', {
            state: 'rejected',
            lastFailure: structuredAgentSessionRejectedFailure(words)
          })
        ],
        [{ ...queued('mine'), dispatchState: 'rejected', ...words }],
        [],
        true
      )
    ).toEqual({
      [agentJournalSubmissionKey('mine')]:
        'Claude is not signed in for the selected account. Sign in first.'
    })
  })
})
