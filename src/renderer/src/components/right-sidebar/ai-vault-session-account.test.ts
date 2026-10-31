import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveAiVaultSessionAccount } from './ai-vault-session-account'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'

vi.mock('../../store', () => ({ useAppStore: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const claude = {
  id: 'recorded',
  email: 'recorded@example.com',
  managedAuthPath: '/accounts/claude',
  authMethod: 'unknown' as const,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}
const codex = {
  id: 'recorded',
  email: 'recorded@example.com',
  managedHomePath: '/accounts/codex',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}
const settings = {
  claudeManagedAccounts: [claude],
  codexManagedAccounts: [codex],
  activeClaudeManagedAccountId: 'another',
  activeCodexManagedAccountId: 'another'
}

function session(agent: AiVaultSession['agent'], path: string): AiVaultSession {
  return {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    agent,
    accountHome: { variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', path }
  }
}

describe('session account labels', () => {
  it('preserves first matching routed home, saved path and summary collisions', () => {
    const source = session('claude', claude.managedAuthPath)
    const first = {
      ...claude,
      id: 'first',
      home: claude.managedAuthPath,
      email: 'first@example.com'
    }
    const second = { ...first, id: 'second', email: 'second@example.com' }
    expect(
      resolveAiVaultSessionAccount(source, settings, {
        claude: { activeAccountId: 'second', accounts: [first, second] }
      })
    ).toBe(first.email)
    const saved = { ...codex, id: 'first' }
    const savedSecond = { ...saved, id: 'second', email: 'second@example.com' }
    expect(
      resolveAiVaultSessionAccount(
        session('codex', codex.managedHomePath),
        {
          ...settings,
          codexManagedAccounts: [saved, savedSecond]
        },
        { codex: { activeAccountId: 'second', accounts: [saved, savedSecond] } }
      )
    ).toBe(saved.email)
    expect(
      resolveAiVaultSessionAccount(source, settings, {
        claude: {
          activeAccountId: null,
          accounts: [
            { ...claude, email: 'older-first@example.com' },
            { ...claude, email: 'older-second@example.com' }
          ]
        }
      })
    ).toBe('older-first@example.com')
  })

  it('compares Windows paths and requires the recorded WSL distro for Linux homes', () => {
    expect(
      resolveAiVaultSessionAccount(
        session('codex', 'C:\\ACCOUNTS\\CODEX\\'),
        {
          ...settings,
          codexManagedAccounts: [{ ...codex, managedHomePath: 'c:/accounts/codex' }]
        },
        null
      )
    ).toBe(codex.email)
    const wslSettings = {
      ...settings,
      claudeManagedAccounts: [
        {
          ...claude,
          managedAuthRuntime: 'wsl' as const,
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/me/.claude'
        }
      ]
    }
    const wsl = { ...session('claude', '/home/me/.claude'), accountWslDistro: 'Ubuntu' }
    const olderRoster = {
      claude: { accounts: wslSettings.claudeManagedAccounts, activeAccountId: null }
    }
    expect(resolveAiVaultSessionAccount(wsl, wslSettings, olderRoster)).toBe(claude.email)
    expect(
      resolveAiVaultSessionAccount({ ...wsl, accountWslDistro: 'Debian' }, wslSettings, olderRoster)
    ).toBeNull()
    expect(
      resolveAiVaultSessionAccount(
        { ...wsl, accountWslDistro: undefined },
        wslSettings,
        olderRoster
      )
    ).toBeNull()
  })

  it('keeps explicit unmanaged data accounts as default and unsupported bindings unknown', () => {
    expect(
      resolveAiVaultSessionAccount(
        {
          ...session('opencode', '/unused'),
          accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
        },
        settings,
        null
      )
    ).toBe('System default')
    expect(resolveAiVaultSessionAccount(session('pi', '/pi'), settings, null)).toBeNull()
  })
})
