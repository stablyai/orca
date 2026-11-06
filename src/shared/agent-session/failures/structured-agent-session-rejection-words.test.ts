import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from './agent-session-failure'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentSessionWriteNoticeEnglish } from './agent-session-refusal-notice'
import {
  structuredAgentSessionRecordedRejectionParts,
  structuredAgentSessionRejectionParts
} from './structured-agent-session-rejection-words'

function notice(reason: string | null, fact?: AgentSessionFailureFact): string {
  return agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, 'send', fact))
}

describe('what a rejection shows the reader', () => {
  it('never puts the transport marker on screen', () => {
    const shown = notice('provider_write_failed: broken pipe')
    expect(shown).not.toContain('provider_write_failed')
    expect(shown).not.toContain('broken pipe')
    expect(shown).toBe("Orca couldn't reach the agent. Your message was not sent.")
  })
})

// A row that carries the host's fact is worded from it; the reason is not read.
describe('what a rejection with a typed fact shows the reader', () => {
  it('says only that the message was not sent for a fact it cannot place', () => {
    expect(notice('A sentence a newer host wrote.', JSON.parse('{"kind":"fromTheFuture"}'))).toBe(
      'Your message was not sent.'
    )
    expect(notice('Compaction failed.', { kind: 'compactionFailed' })).toBe(
      'Your message was not sent.'
    )
  })
})

describe('the line under a recorded rejection', () => {
  const signedOut: AgentSessionFailureFact = { kind: 'notSignedIn' }
  const recorded = (reason: string | null, rejection?: AgentSessionFailureFact) =>
    structuredAgentSessionRecordedRejectionParts(
      {
        clientMessageId: 'sent',
        fence: 1,
        payloadFingerprint: 'sent',
        dispatchState: 'rejected',
        providerItemId: null,
        reason,
        submittedAt: 1,
        resolvedAt: 2,
        ...(rejection ? { rejection } : {})
      } satisfies AgentJournalSubmission,
      { agentName: 'Claude' },
      [signedOut]
    )
  const line = (...args: Parameters<typeof recorded>) =>
    agentSessionWriteNoticeEnglish(recorded(...args))

  it('says only that it was not sent when a loaded row already states the reason', () => {
    expect(line('Written by the host.', signedOut)).toBe('Your message was not sent.')
  })
})

// Clients reword a recorded rejection from its fact and their own `{ agentName }` alone.
describe('an agent update the refused model needs', () => {
  const rejected = (rejection: unknown) =>
    agentSessionWriteNoticeEnglish(
      structuredAgentSessionRecordedRejectionParts(
        {
          clientMessageId: 'sent',
          fence: 1,
          payloadFingerprint: 'sent',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'Written by the host.',
          submittedAt: 1,
          resolvedAt: 2,
          rejection: AgentSessionFailureFactSchema.parse(rejection)
        } satisfies AgentJournalSubmission,
        { agentName: 'OMP' },
        []
      )
    )
  const fact = (agentUpdate?: string) => ({
    kind: 'modelUnavailable',
    detail: { text: '@worker_be', audience: 'log' },
    ...(agentUpdate === undefined ? {} : { agentUpdate })
  })

  it('survives the journal and names the release to update to', () => {
    expect(rejected(fact('18.1.9'))).toContain(
      "OMP couldn't use @worker_be. Update OMP to 18.1.9 or later to keep it after a restart, or pick another model and send again."
    )
    expect(rejected(fact())).toContain(
      "OMP couldn't use @worker_be. Pick another model and send again."
    )
  })

  it("keeps the host's sentence when the release is not a version this reader can place", () => {
    expect(rejected(fact('latest'))).toContain('Written by the host.')
  })
})
