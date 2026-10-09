// What a rejection puts on the reader's screen: the desktop row, the phone and a returned card.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-start-failure-facts'
import { structuredAgentSessionStartFailureRowIdentity } from './structured-agent-session-start-failure-row-key'
import type { AgentSessionFailureFact } from './agent-session-failure'
import { agentSessionWriteNoticeEnglish } from './agent-session-refusal-notice'
import { DISPATCH_REJECTED_QUEUE_FULL } from './structured-agent-session-dispatch-rejection'
import {
  structuredAgentSessionRecordedRejectionParts,
  structuredAgentSessionRejectionNotice,
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
    expect(shown).toBe("The agent couldn't receive this message. Send it again.")
  })

  it("shows a content rejection in the provider's own words", () => {
    expect(notice('Claude messages support at most 20 images')).toBe(
      'Claude messages support at most 20 images'
    )
  })

  it.each([
    'The provider stopped before it finished starting.',
    'The provider did not accept this message.',
    'The provider did not accept this message: provider_write_failed: stand-in rejected the turn.'
  ])(
    'uses the known agent for a legacy host sentence without exposing its internals: %s',
    (reason) => {
      expect(
        agentSessionWriteNoticeEnglish(
          structuredAgentSessionRejectionParts(reason, 'send', undefined, { agentName: 'Codex' })
        )
      ).toBe("Codex didn't accept this message.")
    }
  )

  it('never puts a legacy or local-capacity marker on screen', () => {
    expect(notice('not_delivered')).toBe('Your message was not sent.')
    expect(notice(DISPATCH_REJECTED_QUEUE_FULL)).toBe('Your message was not sent.')
  })

  it('claims no cause when the rejection names none', () => {
    expect(notice(null)).toBe('Your message was not sent.')
  })

  it('tells the phone how to send it again after a transport failure', () => {
    const phone = structuredAgentSessionRejectionNotice('provider_write_failed', 'composer-send')
    expect(phone.startsWith("The agent couldn't receive this message. Send it again.")).toBe(true)
    expect(phone).toBe(notice('provider_write_failed'))
  })
})

// A row that carries the host's fact is worded from it; the reason is not read.
describe('what a rejection with a typed fact shows the reader', () => {
  it('says Orca could not hand the message over, whatever the reason holds', () => {
    for (const reason of ['provider_write_failed', 'Something unrelated.']) {
      expect(notice(reason, { kind: 'writeFailed' })).toBe(
        "The agent couldn't receive this message. Send it again."
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

function rejected(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: 'sent',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'provider_write_failed: broken pipe',
    submittedAt: 1,
    resolvedAt: 1,
    ...patch
  }
}

function startRow(fact: AgentSessionFailureFact): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen')),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
    }
  }
}

function line(
  submission: AgentJournalSubmission,
  items: readonly AgentJournalRenderItem[] = []
): string {
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionRecordedRejectionParts(
      submission,
      { agentName: 'Claude' },
      structuredAgentSessionStartFailureFacts(items)
    )
  )
}

describe('the line under a message the host recorded and then rejected', () => {
  it("says why, in the host's words", () => {
    expect(line(rejected())).toBe("Claude couldn't receive this message. Send it again.")
    expect(line(rejected({ reason: 'Claude does not support .bmp' }))).toBe(
      'Claude does not support .bmp'
    )
  })

  it("words the host's typed fact when no loaded row states it", () => {
    const startFailed: AgentSessionFailureFact = { kind: 'startFailed' }
    expect(line(rejected({ reason: 'Written by the host.', rejection: startFailed }))).toBe(
      "Claude couldn't start. Send your message to try again."
    )
  })

  it('says only that it was not sent when a loaded start-failure row already says why', () => {
    const startFailed: AgentSessionFailureFact = { kind: 'startFailed' }
    expect(
      line(rejected({ reason: 'Written by the host.', rejection: startFailed }), [
        startRow(startFailed)
      ])
    ).toBe('Your message was not sent.')
  })

  it('keeps its own words when the loaded start row states a different failure', () => {
    const conflict: AgentSessionFailureFact = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
    }
    expect(
      line(rejected({ reason: 'Written by the host.', rejection: conflict }), [
        startRow({ kind: 'startFailed' })
      ])
    ).toBe(
      "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    )
  })
})
