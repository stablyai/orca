import { describe, expect, it } from 'vitest'
import { aiVaultSessionClaudeAccountId } from './ai-vault-session-claude-account'

const home = (path: string) => ({ variable: 'CLAUDE_CONFIG_DIR', path })

describe('aiVaultSessionClaudeAccountId', () => {
  it('reads the saved account from Windows and POSIX account folders', () => {
    expect(
      aiVaultSessionClaudeAccountId({
        agent: 'claude',
        accountHome: home('C:\\Users\\me\\AppData\\Roaming\\orca\\claude-profiles\\a1-b2\\home')
      })
    ).toBe('a1-b2')
    expect(
      aiVaultSessionClaudeAccountId({
        agent: 'claude',
        accountHome: home('/home/me/.config/orca/claude-profiles/a1-b2/home/')
      })
    ).toBe('a1-b2')
  })

  it('tells System default from an unknown account', () => {
    expect(aiVaultSessionClaudeAccountId({ agent: 'claude', accountHome: null })).toBeNull()
    expect(
      aiVaultSessionClaudeAccountId({
        agent: 'claude',
        accountHome: home('C:\\Users\\me\\.claude')
      })
    ).toBeNull()
    expect(aiVaultSessionClaudeAccountId({ agent: 'claude' })).toBeUndefined()
    expect(
      aiVaultSessionClaudeAccountId({
        agent: 'codex',
        accountHome: home('/x/claude-profiles/a/home')
      })
    ).toBeUndefined()
  })
})
