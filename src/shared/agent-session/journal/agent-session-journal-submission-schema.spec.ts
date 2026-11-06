import { expect, it } from 'vitest'

import {
  AgentJournalSubmissionSchema,
  isAdmissibleAgentJournalSubmission
} from './agent-session-journal-submission-schema'

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
