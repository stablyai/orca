import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import { useAppStore } from '@/store'
import {
  launchWithClaudeAccountChoice,
  shouldPromptForClaudeAccount
} from './choose-claude-launch-account'
import { claudeAccountPinningUnsupportedReasonInState } from '../settings/repository-claude-account'

vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

function account(id: string): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

const twoAccounts = [account('a'), account('b')]

describe('shouldPromptForClaudeAccount', () => {
  it('does not prompt without a preference while the setting is off', () => {
    expect(
      shouldPromptForClaudeAccount({
        repo: repo(),
        settings: { askClaudeAccountPerProject: false },
        accounts: twoAccounts
      })
    ).toBe(false)
    expect(
      shouldPromptForClaudeAccount({
        repo: repo(),
        settings: { askClaudeAccountPerProject: true },
        accounts: twoAccounts
      })
    ).toBe(true)
  })

  it('prompts for an ask preference with two or more accounts', () => {
    const askRepo = repo({ agentAccounts: { claude: { mode: 'ask' } } })
    expect(
      shouldPromptForClaudeAccount({ repo: askRepo, settings: {}, accounts: twoAccounts })
    ).toBe(true)
    expect(
      shouldPromptForClaudeAccount({ repo: askRepo, settings: {}, accounts: [account('a')] })
    ).toBe(false)
  })

  it('never prompts for SSH repos or a saved account', () => {
    const settings = { askClaudeAccountPerProject: true }
    expect(
      shouldPromptForClaudeAccount({
        repo: repo({ connectionId: 'ssh-1', agentAccounts: { claude: { mode: 'ask' } } }),
        settings,
        accounts: twoAccounts
      })
    ).toBe(false)
    expect(
      shouldPromptForClaudeAccount({
        repo: repo({ agentAccounts: { claude: { mode: 'account', accountId: 'a' } } }),
        settings,
        accounts: twoAccounts
      })
    ).toBe(false)
  })
})

describe('WSL projects', () => {
  const initialState = useAppStore.getInitialState()
  afterEach(() => useAppStore.setState(initialState, true))

  function wslState(): ReturnType<typeof useAppStore.getState> {
    const askRepo = repo({ path: 'C:\\repo', agentAccounts: { claude: { mode: 'ask' } } })
    useAppStore.setState({
      repos: [askRepo],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the prompt toggle and the Windows runtime default are read on this path.
      settings: {
        askClaudeAccountPerProject: true,
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      } as GlobalSettings
    })
    return useAppStore.getState()
  }

  it('reports WSL as unsupported for pinning, matching the launch runtime', () => {
    const state = wslState()
    expect(claudeAccountPinningUnsupportedReasonInState(state, state.repos[0]!)).toBe('wsl')
  })

  it('launches without prompting', () => {
    wslState()
    const launch = vi.fn()

    launchWithClaudeAccountChoice('claude', { repoId: 'repo-1' }, launch)

    expect(launch).toHaveBeenCalledWith(undefined, false)
  })
})
