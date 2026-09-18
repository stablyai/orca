import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  buildSidebarDefaultAgentStartup: vi.fn(),
  workspaceHasSleepingAgentSessions: vi.fn(() => false),
  storeState: {
    getKnownWorktreeById: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    repos: [] as { id: string; path: string; connectionId: string | null }[],
    settings: null as { defaultTuiAgent: string } | null
  }
}))

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
    (repos: unknown[], repoId: string) =>
      (repos as { id: string }[]).find((repo) => repo.id === repoId) ?? null
  )
}))

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: vi.fn()
}))

vi.mock('@/lib/worktree-agent-activation-gate', () => ({
  workspaceHasSleepingAgentSessions: mocks.workspaceHasSleepingAgentSessions
}))

import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.buildSidebarDefaultAgentStartup.mockReset()
    mocks.workspaceHasSleepingAgentSessions.mockReset()
    mocks.workspaceHasSleepingAgentSessions.mockReturnValue(false)
    mocks.storeState.getKnownWorktreeById.mockReset()
    mocks.storeState.reconcileWorktreeTabModel.mockReset()
    mocks.storeState.reconcileWorktreeTabModel.mockReturnValue({ renderableTabCount: 0 })
    mocks.storeState.repos = []
    mocks.storeState.settings = null
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-vm' })

    resolveResume?.(null)
    await activation
  })

  it('seeds the configured default agent when a sidebar click opens an empty worktree', async () => {
    const startup = { command: 'codex', launchAgent: 'codex' }
    stubSidebarDefaultAgentStore(startup)

    await activateWorktreeFromSidebar('wt-empty', undefined, { launchDefaultAgent: true })

    expect(mocks.storeState.reconcileWorktreeTabModel).toHaveBeenCalledWith('wt-empty')
    expect(mocks.workspaceHasSleepingAgentSessions).toHaveBeenCalledWith(
      mocks.storeState,
      'wt-empty'
    )
    expect(mocks.buildSidebarDefaultAgentStartup).toHaveBeenCalledWith(
      mocks.storeState.settings,
      mocks.storeState.repos[0],
      undefined
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-empty', {
      navigationIntent: 'user-open',
      revealInSidebar: false,
      startup
    })
  })

  it('does not attach default-agent startup when the worktree already has renderable tabs', async () => {
    stubSidebarDefaultAgentStore()
    mocks.storeState.reconcileWorktreeTabModel.mockReturnValue({ renderableTabCount: 1 })

    await activateWorktreeFromSidebar('wt-tabs', undefined, { launchDefaultAgent: true })

    expect(mocks.buildSidebarDefaultAgentStartup).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-tabs', {
      revealInSidebar: false
    })
  })

  it('does not attach default-agent startup when the worktree has sleeping agent sessions', async () => {
    stubSidebarDefaultAgentStore()
    mocks.workspaceHasSleepingAgentSessions.mockReturnValue(true)

    await activateWorktreeFromSidebar('wt-slept-agent', undefined, { launchDefaultAgent: true })

    expect(mocks.buildSidebarDefaultAgentStartup).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-slept-agent', {
      revealInSidebar: false
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
