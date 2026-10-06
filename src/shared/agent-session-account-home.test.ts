import { describe, expect, it } from 'vitest'
import {
  agentConfigDirectoryVariable,
  agentSessionAccountHome,
  isAgentConfigDirectoryVariable
} from './agent-session-account-home'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'

describe('agent session account home', () => {
  it('pins the variables older builds wrote and read', () => {
    expect(agentConfigDirectoryVariable('claude')).toBe('CLAUDE_CONFIG_DIR')
    expect(agentConfigDirectoryVariable('codex')).toBe('CODEX_HOME')
    expect(JSON.stringify(agentSessionAccountHome('codex', '/home/dev/.codex'))).toBe(
      '{"variable":"CODEX_HOME","path":"/home/dev/.codex"}'
    )
  })

  it('admits only a variable some agent declares', () => {
    expect(isAgentConfigDirectoryVariable('CLAUDE_CONFIG_DIR')).toBe(true)
    expect(isAgentConfigDirectoryVariable('CODEX_HOME')).toBe(true)
    expect(isAgentConfigDirectoryVariable('PATH')).toBe(false)
    expect(isAgentConfigDirectoryVariable(undefined)).toBe(false)
  })

  it('refuses a stored record whose account home names an undeclared variable', () => {
    const record = encodeAgentSessionRecord(agentSessionRecordFixture())
    expect(isPersistedAgentSessionRecord(record)).toBe(true)
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        accountHome: { variable: 'LD_PRELOAD', path: '/tmp/x' }
      })
    ).toBe(false)
  })
})
