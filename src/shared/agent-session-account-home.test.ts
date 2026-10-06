import { describe, expect, it } from 'vitest'
import { agentSessionAccountHome, isAgentSessionAccountHome } from './agent-session-account-home'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'

describe('agent session account home', () => {
  it('stores the variable and path exactly as older builds wrote them', () => {
    expect(
      JSON.stringify(
        agentSessionAccountHome({ accountHomeVariable: 'CODEX_HOME' }, '/home/dev/.codex')
      )
    ).toBe('{"variable":"CODEX_HOME","path":"/home/dev/.codex"}')
  })

  // Whether the variable is the record's own agent's is decided when its agent would start, since
  // it becomes the child's environment (structured-agent-session-drivability.test.ts).
  it('reads any well-formed variable, and sets aside one that is not a variable name', () => {
    const record = encodeAgentSessionRecord(agentSessionRecordFixture())
    const withVariable = (variable: string) =>
      isPersistedAgentSessionRecord({ ...record, accountHome: { variable, path: '/tmp/x' } })
    expect(withVariable('CODEX_HOME')).toBe(true)
    expect(withVariable('GROK_HOME')).toBe(true)
    for (const malformed of ['', 'A B', '1HOME', 'HOME=x', 'X'.repeat(129)]) {
      expect(withVariable(malformed)).toBe(false)
    }
  })
})

// Generic registered agents retain their own variables; profile annotations keep their stronger identity.
it('retains captured profile ownership through neutral-handle persistence', () => {
  const record = agentSessionRecordFixture()
  const profile = {
    id: 'work',
    name: 'Work',
    agent: 'claude' as const,
    hostId: 'local' as const,
    executable: '/trusted/claude',
    binding: { kind: 'managed' as const, accountId: 'a' },
    resolvedHome: record.accountHome.path,
    identity: { kind: 'verified' as const, subject: 'a', displayName: 'A' }
  }
  record.accountHome.agentProfile = profile
  const stored = encodeAgentSessionRecord(record)
  expect(isPersistedAgentSessionRecord(stored)).toBe(true)
  expect(stored.accountHome.agentProfile).toEqual(profile)
  expect(
    isPersistedAgentSessionRecord({
      ...stored,
      location: { ...stored.location, executionHostId: 'ssh:other' }
    })
  ).toBe(false)
  expect(isAgentSessionAccountHome({ ...stored.accountHome, variable: 'GROK_HOME' })).toBe(false)
  expect(isAgentSessionAccountHome({ ...stored.accountHome, path: '/other' })).toBe(false)
  expect(isAgentSessionAccountHome({ ...stored.accountHome, claudeAccountId: 'other' })).toBe(false)
})
