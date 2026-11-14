import { describe, expect, it } from 'vitest'
import { isClaudeWorkspacePinned } from './worktree-account-pin-settings'

describe('isClaudeWorkspacePinned', () => {
  const settings = { claudeAccountPinsByWorktree: { 'repo::wt-1': 'acct-a' } }

  it('pins host launches in a pinned workspace only', () => {
    expect(isClaudeWorkspacePinned(settings, { workspaceId: 'repo::wt-1', wslDistro: null })).toBe(
      true
    )
    expect(isClaudeWorkspacePinned(settings, { workspaceId: 'repo::wt-2', wslDistro: null })).toBe(
      false
    )
    expect(
      isClaudeWorkspacePinned(settings, { workspaceId: 'repo::wt-1', wslDistro: 'Ubuntu' })
    ).toBe(false)
  })
})
