import { describe, expect, it } from 'vitest'
import {
  ACTIVE_CLAUDE_ACCOUNT,
  isPinnableClaudeAccountId,
  normalizeRepoAgentAccounts,
  repoAgentAccountsEqual
} from './project-claude-account-preference'

describe('normalizeRepoAgentAccounts', () => {
  it('keeps ask and account modes and trims ids', () => {
    expect(normalizeRepoAgentAccounts({ claude: { mode: 'ask' } })).toEqual({
      claude: { mode: 'ask' }
    })
    expect(
      normalizeRepoAgentAccounts({ claude: { mode: 'account', accountId: ' acct-1 ' } })
    ).toEqual({
      claude: { mode: 'account', accountId: 'acct-1' }
    })
  })

  it('rejects malformed shapes', () => {
    expect(normalizeRepoAgentAccounts(null)).toBeNull()
    expect(normalizeRepoAgentAccounts({ claude: { mode: 'account' } })).toBeNull()
    expect(
      normalizeRepoAgentAccounts({ claude: { mode: 'account', accountId: ACTIVE_CLAUDE_ACCOUNT } })
    ).toBeNull()
    expect(normalizeRepoAgentAccounts({ claude: { mode: 'nope' } })).toBeNull()
    expect(normalizeRepoAgentAccounts({})).toBeNull()
  })

  it('compares structurally', () => {
    expect(repoAgentAccountsEqual({ claude: { mode: 'ask' } }, { claude: { mode: 'ask' } })).toBe(
      true
    )
    expect(
      repoAgentAccountsEqual(
        { claude: { mode: 'ask' } },
        { claude: { mode: 'account', accountId: 'a' } }
      )
    ).toBe(false)
  })

  it('treats the active sentinel as not pinnable', () => {
    expect(isPinnableClaudeAccountId('acct-1')).toBe(true)
    expect(isPinnableClaudeAccountId(ACTIVE_CLAUDE_ACCOUNT)).toBe(false)
    expect(isPinnableClaudeAccountId('')).toBe(false)
  })
})
