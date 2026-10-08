import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionWireRefusal } from './agent-session-wire'
import {
  structuredAgentSessionSendEvidence,
  type StructuredAgentSessionSendAnswer
} from './structured-agent-session-send-evidence'

function refused(code: string, reason?: string): StructuredAgentSessionSendAnswer {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture names codes from the wire list.
  const refusal = {
    code,
    message: code,
    ...(reason ? { details: { reason } } : {})
  } as AgentSessionWireRefusal
  return { kind: 'result', result: { ok: false, refusal } }
}

const recorded: StructuredAgentSessionSendAnswer = {
  kind: 'result',
  result: {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 1 },
    value: { clientMessageId: 'm', queued: { messageId: 'm', position: 0, state: 'waiting' } }
  }
}

function withRow(fields: Partial<AgentJournalSubmission>): StructuredAgentSessionSendAnswer {
  return {
    kind: 'result',
    result: {
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: 'm',
        submission: {
          clientMessageId: 'm',
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: 1,
          ...fields
        }
      }
    }
  }
}

function thrown(rpcCode: string | undefined): StructuredAgentSessionSendAnswer {
  return { kind: 'thrown', error: new Error(rpcCode ?? 'socket closed'), rpcCode }
}

describe('structuredAgentSessionSendEvidence', () => {
  it('reads any ok answer as the host holding the message', () => {
    expect(structuredAgentSessionSendEvidence(recorded).kind).toBe('recorded')
  })

  it('reads a row the host returns, in any state, as its own from then on', () => {
    for (const dispatchState of ['pending', 'accepted', 'rejected', 'unknown'] as const) {
      expect(structuredAgentSessionSendEvidence(withRow({ dispatchState })).kind).toBe('recorded')
    }
    // A restart lost its outcome, or a queued card's hand-off: a record, never a probe.
    const rows: Partial<AgentJournalSubmission>[] = [
      { dispatchState: 'unknown', recovered: true, reason: 'host_restarted' },
      { dispatchState: 'rejected', clientMessageId: 'other', queuedMessageId: 'm' },
      { dispatchState: 'rejected', keptAsQueuedMessageId: 'm' }
    ]
    for (const row of rows) {
      expect(structuredAgentSessionSendEvidence(withRow(row)).kind).toBe('recorded')
    }
  })

  it('reads a made-up row for an id the host journal lost as unconfirmed, not recorded', () => {
    expect(
      structuredAgentSessionSendEvidence(
        withRow({
          dispatchState: 'unknown',
          reason: 'durable_send_submission_missing',
          recovered: true
        })
      ).kind
    ).toBe('uncertain')
  })

  it('reads no thrown error as proof: a timeout, a closed socket or a thrown refusal', () => {
    for (const rpcCode of [
      'runtime_timeout',
      'remote_runtime_unavailable',
      'runtime_unavailable',
      undefined
    ]) {
      expect(structuredAgentSessionSendEvidence(thrown(rpcCode)).kind).toBe('uncertain')
    }
    const thrownRefusal = {
      response: { error: { data: { refusal: { code: 'agent_session_journal_unreadable' } } } }
    }
    expect(
      structuredAgentSessionSendEvidence({
        kind: 'thrown',
        error: thrownRefusal,
        rpcCode: 'invalid_argument'
      }).kind
    ).toBe('uncertain')
  })

  it('treats a call the host turned away before running it as never written', () => {
    for (const rpcCode of ['method_not_found', 'invalid_argument', 'unauthorized']) {
      expect(structuredAgentSessionSendEvidence(thrown(rpcCode)).kind).toBe('not-recorded')
    }
  })

  it('reads an unknown outcome or a lost result as unconfirmed, and an unconfirmed rewind as not sent', () => {
    for (const reason of ['outcomeUnknown', 'resultLost']) {
      expect(
        structuredAgentSessionSendEvidence(refused('agent_session_operation_unknown', reason)).kind
      ).toBe('uncertain')
    }
    expect(
      structuredAgentSessionSendEvidence(
        refused('agent_session_operation_unknown', 'rewindUnconfirmed')
      ).kind
    ).toBe('not-recorded')
  })

  // The one request is the only one that carried the id, so a refusal of it proves nothing ran.
  it('reads any other refusal as never written', () => {
    for (const answer of [
      refused('agent_session_ownership_unknown', 'sessionNotAttached'),
      refused('agent_session_conflict'),
      refused('agent_session_operation_capacity'),
      refused('agent_session_journal_unreadable'),
      refused('agent_session_operation_expired', 'operationExpired')
    ]) {
      expect(structuredAgentSessionSendEvidence(answer).kind).toBe('not-recorded')
    }
  })
})
