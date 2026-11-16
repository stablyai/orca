import { describe, expect, it } from 'vitest'
import {
  createdWorktreeAccountPinPatch,
  resolveAccountPins,
  workspacePinnedAccount
} from './worktree-account-pin-settings'

describe('workspacePinnedAccount', () => {
  const settings = {
    claudeAccountPinsByWorktree: { 'repo::wt-1': 'claude-a' },
    codexAccountPinsByWorktree: { 'repo::wt-1': 'codex-a' }
  }
  const host = (workspaceId: string) => ({ workspaceId, wslDistro: null })

  it("reads each agent's own pin for host launches only", () => {
    expect(workspacePinnedAccount(settings, 'claude', host('repo::wt-1'))).toBe('claude-a')
    expect(workspacePinnedAccount(settings, 'codex', host('repo::wt-1'))).toBe('codex-a')
    expect(workspacePinnedAccount(settings, 'gemini', host('repo::wt-1'))).toBeUndefined()
    expect(workspacePinnedAccount(settings, 'claude', host('repo::wt-2'))).toBeUndefined()
    expect(
      workspacePinnedAccount(settings, 'claude', { workspaceId: 'repo::wt-1', wslDistro: 'Ubuntu' })
    ).toBeUndefined()
  })
})

describe('createdWorktreeAccountPinPatch', () => {
  const account = (id: string, runtime?: 'wsl') => ({
    id,
    email: `${id}@example.com`,
    managedAuthRuntime: runtime,
    managedHomeRuntime: runtime
  })
  const settings = {
    claudeManagedAccounts: [account('claude-a'), account('claude-wsl', 'wsl')],
    codexManagedAccounts: [account('codex-a')],
    claudeAccountPinsByWorktree: { 'repo::old': 'claude-a' }
  }

  it('pins the new worktree to the chosen accounts and keeps the other pins', () => {
    expect(
      createdWorktreeAccountPinPatch(settings, 'repo::new', {
        claude: 'claude-a',
        codex: 'codex-a'
      })
    ).toEqual({
      claudeAccountPinsByWorktree: { 'repo::old': 'claude-a', 'repo::new': 'claude-a' },
      codexAccountPinsByWorktree: { 'repo::new': 'codex-a' }
    })
  })

  it('skips accounts that are gone or only run in WSL', () => {
    expect(
      createdWorktreeAccountPinPatch(settings, 'repo::new', { claude: 'claude-wsl' })
    ).toBeNull()
    expect(createdWorktreeAccountPinPatch(settings, 'repo::new', { codex: 'removed' })).toBeNull()
    expect(createdWorktreeAccountPinPatch(settings, 'repo::new', undefined)).toBeNull()
  })
})

describe('resolveAccountPins', () => {
  const settings = {
    claudeManagedAccounts: [
      { id: 'claude-a', email: 'Work@Example.com' },
      { id: 'claude-wsl', email: 'wsl@example.com', managedAuthRuntime: 'wsl' as const }
    ],
    codexManagedAccounts: []
  }

  it('takes an account by email, any case, or by id', () => {
    expect(resolveAccountPins(settings, 'claude', 'work@example.com')).toEqual({
      pins: { claude: 'claude-a' }
    })
    expect(resolveAccountPins(settings, 'claude', 'claude-a')).toEqual({
      pins: { claude: 'claude-a' }
    })
    expect(resolveAccountPins(settings, 'claude', undefined)).toEqual({})
  })

  it('names the accounts it knows when none matches, and refuses other agents', () => {
    expect(resolveAccountPins(settings, 'claude', 'wsl@example.com').error).toContain(
      'Accounts on this machine: Work@Example.com.'
    )
    expect(resolveAccountPins(settings, 'codex', 'x').error).toContain('none saved')
    expect(resolveAccountPins(settings, 'cursor', 'x').error).toContain('only to claude and codex')
  })
})
