import { describe, expect, it } from 'vitest'
import { workspacePinnedAccount } from './worktree-account-pin-settings'

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
