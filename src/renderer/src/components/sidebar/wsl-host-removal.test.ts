import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const workspace: { activeWorktreeId: string | null; ownerHostId: string | null } = {
    activeWorktreeId: null,
    ownerHostId: null
  }
  return {
    warning: vi.fn(),
    setRuntimeEnvironments: vi.fn(),
    setActiveWorktree: vi.fn(),
    workspace
  }
})

vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: mocks.workspace.activeWorktreeId,
      setActiveWorktree: mocks.setActiveWorktree,
      setRuntimeEnvironments: mocks.setRuntimeEnvironments
    })
  }
}))
vi.mock('@/lib/workspace-row-owner-host', () => ({
  workspaceOwnerHostId: () => mocks.workspace.ownerHostId
}))

import { removeWslHost } from './wsl-host-removal'

function stubApi(result: unknown): ReturnType<typeof vi.fn> {
  const remove = vi.fn(async () => result)
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { list: async () => [], wslHosts: { remove } } }
  })
  return remove
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('removeWslHost', () => {
  beforeEach(() => {
    mocks.warning.mockReset()
    mocks.setRuntimeEnvironments.mockReset()
    mocks.setActiveWorktree.mockReset()
    mocks.workspace.activeWorktreeId = null
    mocks.workspace.ownerHostId = null
  })

  it('removes quietly when the server, its daemon and terminals all ended', async () => {
    const remove = stubApi({ stopped: true })
    await removeWslHost('wsl:ubuntu')
    expect(remove).toHaveBeenCalledWith({ environmentId: 'wsl:ubuntu' })
    expect(mocks.setRuntimeEnvironments).toHaveBeenCalledWith([])
    expect(mocks.warning).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('leaves the active workspace when it lived on the removed host', async () => {
    stubApi({ stopped: true })
    mocks.workspace.activeWorktreeId = 'repo::/home/me/app'
    mocks.workspace.ownerHostId = 'runtime:wsl%3Aubuntu'
    await removeWslHost('wsl:ubuntu')
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(null)

    mocks.setActiveWorktree.mockReset()
    mocks.workspace.ownerHostId = 'local'
    await removeWslHost('wsl:ubuntu')
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('says what is still running in the distro, and keeps saying it until dismissed', async () => {
    stubApi({ stopped: false, reason: '1 terminal kept running, so Orca left the server running.' })
    await removeWslHost('wsl:ubuntu')
    expect(mocks.warning).toHaveBeenCalledWith(
      'The host was removed, but something in the distro is still running: 1 terminal kept running, so Orca left the server running.',
      { duration: Infinity }
    )
  })
})
