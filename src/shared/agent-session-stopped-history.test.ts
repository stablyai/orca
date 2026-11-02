// What a Stop leaves owed to the agent: only messages Orca proves it never received, at most once.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact, type SubmissionRejectionKind } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { MAX_PROMPT_BYTES } from './rpc-contract/structured-agent-session-message-params'
import {
  agentSessionStoppedHistoryOwed,
  selectStoppedHistory,
  STOPPED_MESSAGE_FRAMING_BYTES,
  type StoppedHistoryJournal
} from './agent-session-stopped-history'

function message(
  text: string,
  extra: Partial<AgentJournalMessageItem> = {}
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }],
    ...extra
  }
}

function sent(
  id: string,
  sequence: number,
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: `fp-${id}`,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: sequence,
    resolvedAt: null,
    handoverRecorded: true,
    acceptedSequence: sequence,
    origin: 'client',
    source: { kind: 'user' },
    ...extra
  }
}

function rejected(
  kind: SubmissionRejectionKind,
  extra: { neverReachedAgent?: true } = {}
): Partial<AgentJournalSubmission> {
  return {
    dispatchState: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact(kind, extra), {
      surface: 'rejection'
    })
  }
}

/** A Stop's withdrawal with proof the agent never got it. */
const STOPPED = rejected('cancelled', { neverReachedAgent: true })

function owed(
  submissions: AgentJournalSubmission[],
  options: {
    carried?: Record<string, string[]>
    clearSequence?: number
    bodies?: Record<string, AgentJournalItemBody>
  } = {}
): string[] {
  const journal: StoppedHistoryJournal = {
    submissions,
    carried: new Map(Object.entries(options.carried ?? {})),
    clearSequence: options.clearSequence ?? 0,
    body: (id) => options.bodies?.[id] ?? message(id)
  }
  return agentSessionStoppedHistoryOwed(journal).map((entry) => entry.clientMessageId)
}

describe('which stopped messages the agent is owed', () => {
  it("owes only a person's own sends a Stop proved unwritten, in order, after the latest /clear", () => {
    const mail = message('mail', { from: { kind: 'agent', senders: [], orchestration: null } })
    expect(
      owed(
        [
          sent('b', 8, STOPPED),
          sent('a', 7, STOPPED),
          sent('beforeClear', 2, STOPPED),
          // Old journals and a Claude queue-clear carry no proof.
          sent('unproven', 6, rejected('cancelled')),
          sent('doubt', 6, { dispatchState: 'unknown', reason: 'doubt' }),
          sent('mail', 6, STOPPED),
          sent('slash', 6, STOPPED),
          sent('card', 6, { ...STOPPED, queuedMessageId: 'card' })
        ],
        { clearSequence: 5, bodies: { mail, slash: message('/review foo') } }
      )
    ).toEqual(['a', 'b'])
  })
})

describe('what one delivery holds', () => {
  it('fits beside the send, newest first; one too large for any send never holds back the rest', () => {
    const largest = 'x'.repeat(MAX_PROMPT_BYTES - STOPPED_MESSAGE_FRAMING_BYTES - 5)
    const tooLarge = 'x'.repeat(MAX_PROMPT_BYTES)
    expect(
      owed([sent('a', 2, STOPPED), sent('largest', 3, STOPPED), sent('tooLarge', 4, STOPPED)], {
        bodies: { largest: message(largest), tooLarge: message(tooLarge) }
      })
    ).toEqual(['a', 'largest'])
    // The largest still owed fits beside a one-letter send; the older one is left out, covered.
    const stopped = [
      { clientMessageId: 'a', words: 'first' },
      { clientMessageId: 'largest', words: largest }
    ]
    expect(selectStoppedHistory(stopped, message('x'))).toEqual({
      messages: [stopped[1]],
      covers: ['a', 'largest']
    })
  })
})
