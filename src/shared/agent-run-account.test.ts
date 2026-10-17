import { describe, expect, it } from 'vitest'
import {
  agentRunAccountsEqual,
  readAgentRunAccount,
  type AgentRunAccount
} from './agent-run-account'
import { pickParsedAgentStatusPayload, type AgentStatusIpcPayload } from './agent-status-types'

const CLAUDE: AgentRunAccount = {
  provider: 'claude',
  lane: 'host',
  accountId: 'account-a',
  mode: 'kept',
  shellRoute: 'account'
}

describe('readAgentRunAccount', () => {
  it.each([
    ['a kept Claude facet', CLAUDE],
    [
      'a System default Codex facet',
      { provider: 'codex', lane: 'host', accountId: null, mode: 'follow' }
    ],
    [
      'a Claude facet whose conversation is kept on another account',
      { ...CLAUDE, mode: 'follow', keptElsewhere: true }
    ],
    [
      'a facet Keep cannot be offered for',
      {
        provider: 'codex',
        lane: 'wsl:Ubuntu',
        accountId: 'b',
        mode: 'follow',
        keepUnavailable: 'codex-home-not-keepable'
      }
    ]
  ])('accepts %s', (_label, value) => {
    expect(readAgentRunAccount(value)).toEqual(value)
  })

  it.each([
    ['null', null],
    ['an array', [CLAUDE]],
    ['an unknown provider', { ...CLAUDE, provider: 'gemini' }],
    ['an unknown mode', { ...CLAUDE, mode: 'placed' }],
    ['a path-like id', { ...CLAUDE, accountId: '../home' }],
    ['a numeric id', { ...CLAUDE, accountId: 7 }],
    ['an undefined id', { ...CLAUDE, accountId: undefined }],
    ['a bare distro lane', { ...CLAUDE, lane: 'Ubuntu' }],
    ['an unknown shell route', { ...CLAUDE, shellRoute: 'pane' }],
    ['a shell route on Codex', { ...CLAUDE, provider: 'codex' }],
    ['an unknown keep reason', { ...CLAUDE, keepUnavailable: 'later' }],
    ['a kept-elsewhere flag that is not true', { ...CLAUDE, keptElsewhere: 'yes' }],
    [
      'a kept-elsewhere flag on Codex',
      { provider: 'codex', lane: 'host', accountId: 'b', mode: 'follow', keptElsewhere: true }
    ]
  ])('rejects %s', (_label, value) => {
    expect(readAgentRunAccount(value)).toBeUndefined()
  })

  it('drops unknown fields instead of carrying them', () => {
    expect(readAgentRunAccount({ ...CLAUDE, email: 'someone@example.com' })).toEqual(CLAUDE)
  })
})

describe('agentRunAccountsEqual', () => {
  it('compares every field and treats null and absent as no facet', () => {
    expect(agentRunAccountsEqual(CLAUDE, { ...CLAUDE })).toBe(true)
    expect(agentRunAccountsEqual(CLAUDE, { ...CLAUDE, mode: 'follow' })).toBe(false)
    expect(agentRunAccountsEqual(CLAUDE, { ...CLAUDE, shellRoute: 'selected' })).toBe(false)
    expect(agentRunAccountsEqual(CLAUDE, { ...CLAUDE, keepUnavailable: 'no-session' })).toBe(false)
    expect(agentRunAccountsEqual(CLAUDE, { ...CLAUDE, keptElsewhere: true })).toBe(false)
    expect(agentRunAccountsEqual(null, undefined)).toBe(true)
    expect(agentRunAccountsEqual(CLAUDE, null)).toBe(false)
  })
})

describe('client-visible projections', () => {
  it('never copy the facet into the parsed status payload', () => {
    const row: AgentStatusIpcPayload = {
      paneKey: 'tab:leaf',
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1,
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      runAccount: CLAUDE
    }
    // Positive control: the host-side row does carry it.
    expect(row.runAccount).toEqual(CLAUDE)
    expect(pickParsedAgentStatusPayload(row)).not.toHaveProperty('runAccount')
  })
})
