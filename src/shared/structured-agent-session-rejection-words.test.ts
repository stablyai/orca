import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionWriteNoticeEnglish } from './agent-session-refusal-notice'
import { DISPATCH_REJECTED_QUEUE_FULL } from './structured-agent-session-dispatch-rejection'
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

  it('never puts a legacy or local-capacity marker on screen', () => {
    expect(notice('not_delivered')).toBe('Your message was not sent.')
    expect(notice(DISPATCH_REJECTED_QUEUE_FULL)).toBe('Your message was not sent.')
  })
})

// A row that carries the host's fact is worded from it; the reason is not read.
describe('what a rejection with a typed fact shows the reader', () => {
  it('says Orca could not hand the message over, whatever the reason holds', () => {
    for (const reason of ['provider_write_failed', 'Something unrelated.']) {
      expect(notice(reason, { kind: 'writeFailed' })).toBe(
        "Orca couldn't reach the agent. Your message was not sent."
      )
    }
  })

  it("rebuilds the fact's sentence where a marker stands in for it", () => {
    expect(notice(DISPATCH_REJECTED_QUEUE_FULL, { kind: 'queueFull' })).toBe(
      'Too many messages were waiting for the agent, so this one was not sent.'
    )
  })

  it('words the fact itself, never the sentence the host wrote beside it', () => {
    expect(
      notice('Claude never finished starting, so Orca stopped it.', { kind: 'hostStopped' })
    ).toBe('The agent never finished starting, so Orca stopped it.')
  })

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

  it('words a fact no row states from the fact itself', () => {
    expect(line('Written by the host.', { kind: 'writeFailed' })).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
  })

  it("shows an older host's reason sentence, and never a legacy marker", () => {
    expect(line('Claude messages support at most 20 images')).toBe(
      'Claude messages support at most 20 images'
    )
    expect(line('not_delivered')).toBe('Your message was not sent.')
  })
})
