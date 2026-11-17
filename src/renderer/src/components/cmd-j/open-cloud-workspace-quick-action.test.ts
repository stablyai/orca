import { describe, expect, it, vi } from 'vitest'
import type { CmdJQuickActionContext } from './quick-action-context'
import { getOpenCloudWorkspaceQuickAction } from './open-cloud-workspace-quick-action'

function context(overrides: Partial<CmdJQuickActionContext> = {}): CmdJQuickActionContext {
  return {
    activeView: 'terminal',
    activeWorktreeId: null,
    activeWorktree: null,
    isLoading: false,
    sshStatus: null,
    runtimeMode: 'local-desktop',
    activeGroupId: null,
    openNewBrowserTab: async () => {},
    openBrowserUrl: async () => {},
    openNewMarkdownFile: async () => {},
    openNewTerminalTab: async () => {},
    openCreateWorkspace: () => {},
    deleteActiveWorkspace: () => {},
    openAddQuickCommand: () => {},
    openCloudWorkspacePicker: vi.fn(),
    ...overrides
  }
}

describe('Open cloud workspace… quick action', () => {
  const action = getOpenCloudWorkspaceQuickAction()

  it('opens the picker, with no workspace active (it is how you get to one)', async () => {
    const ctx = context()
    expect(action.isAvailable(ctx)).toEqual({ available: true })
    await expect(action.run(ctx)).resolves.toEqual({ status: 'ok' })
    expect(ctx.openCloudWorkspacePicker).toHaveBeenCalledTimes(1)
  })

  it('is unavailable (so hidden) without Orca Cloud', async () => {
    const ctx = context({ openCloudWorkspacePicker: undefined })
    expect(action.isAvailable(ctx)).toEqual({ available: false, reason: 'no-orca-cloud' })
    await expect(action.run(ctx)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-orca-cloud'
    })
  })
})
