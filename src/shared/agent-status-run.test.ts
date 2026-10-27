import { describe, expect, it } from 'vitest'
import {
  deserializeAgentStatusPtyRunRecord,
  parseAgentStatusProviderAlias,
  parseAgentStatusPtyRunRecord,
  serializeAgentStatusPtyRunRecord,
  type AgentStatusPtyRunRecord
} from './agent-status-run'

function runRecord(overrides: Partial<AgentStatusPtyRunRecord> = {}): AgentStatusPtyRunRecord {
  return {
    runId: 'run-a',
    paneKey: 'tab-1:pane-1',
    attachment: { executionId: 'execution-a' },
    attribution: 'token',
    providerSessions: [
      {
        provider: 'claude',
        sessionKeyKind: 'session_id',
        providerId: 'session-a'
      },
      {
        provider: 'claude',
        sessionKeyKind: 'session_id',
        providerId: 'session-b',
        resetBoundary: true
      }
    ],
    continuityOf: 'run-before-a',
    role: 'root',
    verdict: 'live',
    ...overrides
  }
}

describe('agent status PTY run records', () => {
  it('round-trips run, execution attachment, ordered provider chain, and continuity', () => {
    const record = runRecord()

    expect(deserializeAgentStatusPtyRunRecord(serializeAgentStatusPtyRunRecord(record))).toEqual(
      record
    )
  })

  it('supports an id-less pane-attributed run without inventing a provider alias', () => {
    const record = runRecord({
      attribution: 'pane',
      providerSessions: [],
      role: 'unresolved',
      verdict: 'unverifiable'
    })
    delete record.continuityOf

    expect(deserializeAgentStatusPtyRunRecord(serializeAgentStatusPtyRunRecord(record))).toEqual(
      record
    )
  })

  it('preserves repeated provider ids when reset evidence reports them in order', () => {
    const alias = {
      provider: 'claude' as const,
      sessionKeyKind: 'session_id' as const,
      providerId: 'session-a'
    }
    const record = runRecord({
      providerSessions: [alias, { ...alias, resetBoundary: true }]
    })

    expect(deserializeAgentStatusPtyRunRecord(serializeAgentStatusPtyRunRecord(record))).toEqual(
      record
    )
  })

  it.each([
    { provider: 'unknown', sessionKeyKind: 'session_id', providerId: 'session-a' },
    { provider: 'claude', sessionKeyKind: 'thread_id', providerId: 'session-a' },
    { provider: 'claude', sessionKeyKind: 'session_id', providerId: ' session-a' },
    { provider: 'claude', sessionKeyKind: 'session_id', providerId: '-session-a' },
    {
      provider: 'claude',
      sessionKeyKind: 'session_id',
      providerId: 'session-a',
      transcriptPath: '/private/provider/path'
    }
  ])('rejects malformed provider alias %#', (value) => {
    expect(parseAgentStatusProviderAlias(value)).toBeNull()
  })

  it.each([
    { ...runRecord(), runId: '' },
    { ...runRecord(), continuityOf: 'run-a' },
    { ...runRecord(), continuityOf: undefined },
    { ...runRecord(), attachment: { executionId: 'execution-a', pid: 123 } },
    { ...runRecord(), providerSessions: [{ ...runRecord().providerSessions[0], extra: true }] },
    {
      ...runRecord(),
      providerSessions: [{ ...runRecord().providerSessions[0], resetBoundary: undefined }]
    },
    {
      ...runRecord(),
      providerSessions: [{ ...runRecord().providerSessions[0], resetBoundary: false }]
    },
    {
      ...runRecord(),
      providerSessions: [
        runRecord().providerSessions[0],
        {
          provider: 'codex',
          sessionKeyKind: 'session_id',
          providerId: 'session-b',
          resetBoundary: true
        }
      ]
    },
    { ...runRecord(), role: 'resume' },
    { ...runRecord(), verdict: 'dead' },
    { ...runRecord(), extra: true }
  ])('rejects malformed run record %#', (value) => {
    expect(parseAgentStatusPtyRunRecord(value)).toBeNull()
  })

  it('rejects malformed serialized records', () => {
    expect(deserializeAgentStatusPtyRunRecord('not-json')).toBeNull()
    expect(deserializeAgentStatusPtyRunRecord(JSON.stringify({ runId: 'run-a' }))).toBeNull()
  })
})
