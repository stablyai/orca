import { describe, expect, it } from 'vitest'
import {
  agentSessionAccountHome,
  agentSessionAccountHomesEqual
} from './agent-session-account-home'
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

  it('validates tagged OpenCode locators, keeping ones a newer build added fields to', () => {
    const record = encodeAgentSessionRecord(agentSessionRecordFixture())
    const managed = {
      kind: 'opencode',
      locator: { kind: 'managed', managedProfileId: '123e4567-e89b-42d3-a456-426614174000' }
    } as const
    const unmanaged = { kind: 'opencode', locator: { kind: 'unmanaged' } } as const
    expect(isPersistedAgentSessionRecord({ ...record, accountHome: managed })).toBe(true)
    expect(isPersistedAgentSessionRecord({ ...record, accountHome: unmanaged })).toBe(true)
    expect(agentSessionAccountHomesEqual(managed, unmanaged)).toBe(false)
    expect(agentSessionAccountHomesEqual(managed, { ...managed })).toBe(true)
    expect(agentSessionAccountHomesEqual(unmanaged, { ...unmanaged })).toBe(true)
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        accountHome: { ...managed, path: '/fake/home' }
      })
    ).toBe(true)
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        accountHome: { ...unmanaged, locator: { ...unmanaged.locator, channel: 'beta' } }
      })
    ).toBe(true)
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        accountHome: { ...unmanaged, locator: { kind: 'detached' } }
      })
    ).toBe(false)
  })
})
