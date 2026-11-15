import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../failures/agent-session-wire-refusals'
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
    for (const rpcCode of [
      'runtime_manually_disconnected',
      'runtime_rpc_queue_overloaded',
      'remote_runtime_busy',
      'forbidden',
      'capability_unsupported'
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
})
