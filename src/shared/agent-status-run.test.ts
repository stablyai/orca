import { describe, expect, it } from 'vitest'
import {
  deserializeAgentStatusPtyRunRecord,
  parseAgentStatusExecutionBinding,
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
    attribution: 'execution-attachment',
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

  it('supports an unresolved run without inventing a provider alias', () => {
    const record = runRecord({
      attribution: 'unresolved',
      providerSessions: [],
      role: 'unresolved',
      verdict: 'unverifiable'
    })
    delete record.continuityOf

    expect(deserializeAgentStatusPtyRunRecord(serializeAgentStatusPtyRunRecord(record))).toEqual(
      record
    )
  })

  it('accepts legacy attribution labels while keeping new emissions explicit', () => {
    expect(parseAgentStatusPtyRunRecord(runRecord({ attribution: 'token' }))?.attribution).toBe(
      'token'
    )
    expect(parseAgentStatusPtyRunRecord(runRecord({ attribution: 'pane' }))?.attribution).toBe(
      'pane'
    )
  })

  it('parses the execution binding committed with a live owner', () => {
    expect(
      parseAgentStatusExecutionBinding({
        runId: 'run-a',
        attachment: { executionId: 'execution-a' },
        role: 'root',
        continuityOf: 'run-before-a'
      })
    ).toEqual({
      runId: 'run-a',
      attachment: { executionId: 'execution-a' },
      role: 'root',
      continuityOf: 'run-before-a'
    })
  })

  it.each([
    { runId: '', attachment: { executionId: 'execution-a' }, role: 'root' },
    { runId: 'run-a', attachment: { executionId: '' }, role: 'root' },
    { runId: 'run-a', attachment: { executionId: 'execution-a', pid: 123 }, role: 'root' },
    { runId: 'run-a', attachment: { executionId: 'execution-a' }, role: 'unresolved' },
    {
      runId: 'run-a',
      attachment: { executionId: 'execution-a' },
      role: 'root',
      continuityOf: 'run-a'
    },
    {
      runId: 'run-a',
      attachment: { executionId: 'execution-a' },
      role: 'root',
      extra: true
    }
  ])('rejects malformed execution binding %#', (value) => {
    expect(parseAgentStatusExecutionBinding(value)).toBeNull()
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
