import { describe, expect, it, vi } from 'vitest'
import type { CmdJQuickActionContext } from './quick-action-context'
import { buildCmdJActionResults, rankCmdJMiddleResults } from './palette-results'
import { getCmdJQuickActions } from './quick-actions'
import { makeWorktree } from '@/store/slices/store-test-helpers'

const action = getCmdJQuickActions().find((item) => item.id === 'move-to-status')!

function context(overrides: Partial<CmdJQuickActionContext> = {}): CmdJQuickActionContext {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    activeWorktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1' }),
    isLoading: false,
    sshStatus: null,
    runtimeMode: 'local-desktop',
    activeGroupId: 'group-1',
    openNewBrowserTab: async () => {},
    openBrowserUrl: async () => {},
    openNewMarkdownFile: async () => {},
    openNewTerminalTab: async () => {},
    openCreateWorkspace: () => {},
    deleteActiveWorkspace: () => {},
    openAddQuickCommand: () => {},
    openWorkspaceStatusPicker: () => {},
    ...overrides
  }
}

describe('Move to Status quick action', () => {
  it('is found by the words people use for it', () => {
    const actionResults = buildCmdJActionResults(getCmdJQuickActions())
    for (const query of ['move to status', 'move status', 'set status', 'change status']) {
      const top = rankCmdJMiddleResults({ query, settingsResults: [], actionResults })[0]
      expect(top?.id).toBe('move-to-status')
    }
  })

  it('opens the status picker for the active workspace', async () => {
    const openWorkspaceStatusPicker = vi.fn()
    await expect(action.run(context({ openWorkspaceStatusPicker }))).resolves.toEqual({
      status: 'ok'
    })
    expect(openWorkspaceStatusPicker).toHaveBeenCalledOnce()
  })

  it.each([
    ['no workspace is active', { activeWorktreeId: null }, 'no-active-workspace'],
    ['the workspace did not resolve', { activeWorktree: null }, 'no-active-workspace'],
    ['the settings view is open', { activeView: 'settings' as const }, 'no-active-workspace'],
    ['workspaces are loading', { isLoading: true }, 'loading'],
    ['the workspace is disconnected', { sshStatus: 'disconnected' as const }, 'ssh-disconnected']
  ])('is unavailable when %s', async (_name, overrides, reason) => {
    const openWorkspaceStatusPicker = vi.fn()
    const ctx = context({ ...overrides, openWorkspaceStatusPicker })
    expect(action.isAvailable(ctx)).toEqual({ available: false, reason })
    await expect(action.run(ctx)).resolves.toEqual({ status: 'unavailable', reason })
    expect(openWorkspaceStatusPicker).not.toHaveBeenCalled()
  })
})
