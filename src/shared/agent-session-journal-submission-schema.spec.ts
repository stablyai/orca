import { expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  AgentJournalSubmissionSchema,
  isAdmissibleAgentJournalSubmission
} from './agent-session-journal-submission-schema'

// Persisted and published: a reader that keeps the parsed value must not lose either fact.
it('keeps a kept send’s card id and its source through a parse', () => {
  const kept: AgentJournalSubmission = {
    clientMessageId: 'client-kept',
    fence: 2,
    payloadFingerprint: 'fingerprint-kept',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'Orca restarted before this message was sent.',
    rejection: { kind: 'hostRestarted' },
    submittedAt: 1,
    resolvedAt: 2,
    recovered: true,
    source: { kind: 'user' },
    keptAsQueuedMessageId: 'client-kept'
  }
  expect(isAdmissibleAgentJournalSubmission(kept)).toBe(true)
  expect(AgentJournalSubmissionSchema.parse(kept)).toEqual(kept)
  expect(AgentJournalSubmissionSchema.parse(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
})

it('refuses an empty card id rather than reading it as kept', () => {
  expect(
    isAdmissibleAgentJournalSubmission({
      clientMessageId: 'client-kept',
      fence: 2,
      payloadFingerprint: 'fingerprint-kept',
      dispatchState: 'rejected',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2,
      keptAsQueuedMessageId: ''
    })
  ).toBe(false)
})

it('admits newer fields without replacing or mutating the submission', () => {
  const value = {
    clientMessageId: 'client-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'future-dispatch-state',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    source: { kind: 'future-source', sender: 'retained-by-guard' },
    future: { retained: true }
  }
  const original = structuredClone(value)
  expect(isAdmissibleAgentJournalSubmission(value)).toBe(true)
  expect(value).toEqual(original)
  expect(AgentJournalSubmissionSchema.parse(value).source).toEqual({ kind: 'future-source' })
})
