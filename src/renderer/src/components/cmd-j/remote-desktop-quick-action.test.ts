import { describe, expect, it, vi } from 'vitest'
import type { CmdJQuickActionContext } from './quick-action-context'
import { getRemoteDesktopQuickAction } from './remote-desktop-quick-action'

function context(overrides: Partial<CmdJQuickActionContext> = {}): CmdJQuickActionContext {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    activeWorktree: null,
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
    activeCloudEnvironmentId: 'env-cloud',
    openCloudRemoteDesktop: vi.fn(),
    ...overrides
  }
}

describe('open remote desktop quick action', () => {
  const action = getRemoteDesktopQuickAction()

  it('opens the active cloud workspace’s desktop', async () => {
    const ctx = context()
    expect(action.isAvailable(ctx)).toEqual({ available: true })
    await expect(action.run(ctx)).resolves.toEqual({ status: 'ok' })
    expect(ctx.openCloudRemoteDesktop).toHaveBeenCalledWith('wt-1', 'env-cloud')
  })

  it('is unavailable (so hidden) outside Orca Cloud workspaces', async () => {
    const ctx = context({ activeCloudEnvironmentId: null })
    expect(action.isAvailable(ctx)).toEqual({ available: false, reason: 'not-cloud-workspace' })
    await expect(action.run(ctx)).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-cloud-workspace'
    })
    expect(ctx.openCloudRemoteDesktop).not.toHaveBeenCalled()
  })

  it('is unavailable with no active workspace or while loading', () => {
    expect(action.isAvailable(context({ activeWorktreeId: null }))).toEqual({
      available: false,
      reason: 'no-active-workspace'
    })
    expect(action.isAvailable(context({ isLoading: true }))).toEqual({
      available: false,
      reason: 'loading'
    })
  })
})
