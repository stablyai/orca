import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SidebarActivationRepo = {
  id: string
  path: string
  connectionId: string | null
  executionHostId?: string
}

const mocks = vi.hoisted(() => {
  const repos: SidebarActivationRepo[] = []
  return {
    activateAndRevealFolderWorkspace: vi.fn(),
    activateAndRevealWorktree: vi.fn(),
    buildSidebarDefaultAgentStartup: vi.fn(),
    storeState: {
      getKnownWorktreeById: vi.fn(),
      repos,
      settings: null as { defaultTuiAgent: string } | null
    }
  }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/sidebar-default-agent-startup', () => ({
  buildSidebarDefaultAgentStartup: mocks.buildSidebarDefaultAgentStartup
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.storeState }
}))

vi.mock('@/store/slices/repo-host-identity', () => ({
  findRepoForHost: vi.fn(
    (repos: SidebarActivationRepo[], repoId: string) =>
      repos.find((repo) => repo.id === repoId) ?? null
  )
}))

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: vi.fn()
}))

import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.buildSidebarDefaultAgentStartup.mockReset()
    mocks.storeState.getKnownWorktreeById.mockReset()
    mocks.storeState.repos = []
    mocks.storeState.settings = null
    vi.mocked(getLocalProjectExecutionRuntimeContext).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activates a clicked worktree without sidebar reveal', async () => {
    await activateWorktreeFromSidebar('wt-live')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-live', {
      revealInSidebar: false
    })
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it('does not defer non-VM slept worktree selection behind terminal wake work', async () => {
    await activateWorktreeFromSidebar('wt-slept')

    // Why: setActiveWorktree already defers terminal prep where needed. The
    // sidebar click itself must switch app state immediately.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-slept', {
      revealInSidebar: false
    })
  })

  it('switches immediately while an ephemeral runtime wake is pending', async () => {
    let resolveResume: ((value: null) => void) | undefined
    const resumeWorkspace = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveResume = resolve
        })
    )
    vi.stubGlobal('window', {
      api: { ephemeralVm: { resumeWorkspace } }
    })

    const activation = activateWorktreeFromSidebar('wt-vm')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-vm', {
      revealInSidebar: false
    })
    expect(resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-vm' })

    resolveResume?.(null)
    await activation
  })

  it('routes folder workspace activation through the guarded folder path', async () => {
    await activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('requests default-agent seeding via seedStartupIfEmpty rather than startup', async () => {
    const seedStartupIfEmpty = { command: 'codex', launchAgent: 'codex' }
    stubSidebarDefaultAgentStore(seedStartupIfEmpty)

    await activateWorktreeFromSidebar('wt-empty', undefined, { launchDefaultAgent: true })

    expect(mocks.buildSidebarDefaultAgentStartup).toHaveBeenCalledWith(
      mocks.storeState.settings,
      mocks.storeState.repos[0],
      undefined
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-empty', {
      revealInSidebar: false,
      seedStartupIfEmpty
    })
    expect(mocks.activateAndRevealWorktree.mock.calls[0]?.[1]).not.toHaveProperty('startup')
  })

  it('does not pass startup when a sidebar click includes an execution host', async () => {
    const seedStartupIfEmpty = { command: 'codex', launchAgent: 'codex' }
    stubSidebarDefaultAgentStore(seedStartupIfEmpty)

    await activateWorktreeFromSidebar('wt-empty', 'local', { launchDefaultAgent: true })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-empty', {
      revealInSidebar: false,
      seedStartupIfEmpty,
      executionHostId: 'local'
    })
    expect(mocks.activateAndRevealWorktree.mock.calls[0]?.[1]).not.toHaveProperty('startup')
    expect(getLocalProjectExecutionRuntimeContext).toHaveBeenCalledWith(
      mocks.storeState,
      'wt-empty'
    )
  })

  it('does not apply local project runtime when the selected host is SSH', async () => {
    const seedStartupIfEmpty = { command: 'codex', launchAgent: 'codex' }
    stubSidebarDefaultAgentStore(seedStartupIfEmpty)
    mocks.storeState.getKnownWorktreeById.mockReturnValue({
      id: 'wt-empty',
      repoId: 'repo-1',
      hostId: 'ssh:ssh-1'
    })
    mocks.storeState.repos = [
      { id: 'repo-1', path: '/srv/repo', connectionId: null, executionHostId: 'ssh:ssh-1' }
    ]

    await activateWorktreeFromSidebar('wt-empty', 'ssh:ssh-1', { launchDefaultAgent: true })

    expect(getLocalProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(mocks.buildSidebarDefaultAgentStartup).toHaveBeenCalledWith(
      mocks.storeState.settings,
      mocks.storeState.repos[0],
      undefined
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-empty', {
      revealInSidebar: false,
      seedStartupIfEmpty,
      executionHostId: 'ssh:ssh-1'
    })
  })
})

function stubSidebarDefaultAgentStore(startup = { command: 'codex', launchAgent: 'codex' }): void {
  mocks.storeState.getKnownWorktreeById.mockReturnValue({
    id: 'wt-empty',
    repoId: 'repo-1',
    hostId: undefined
  })
  mocks.storeState.repos = [{ id: 'repo-1', path: '/repo', connectionId: null }]
  mocks.storeState.settings = { defaultTuiAgent: 'codex' }
  mocks.buildSidebarDefaultAgentStartup.mockReturnValue(startup)
}
