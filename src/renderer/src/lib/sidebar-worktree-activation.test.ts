import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  buildSidebarDefaultAgentStartup: vi.fn(),
  storeState: {
    getKnownWorktreeById: vi.fn(),
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

import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.buildSidebarDefaultAgentStartup.mockReset()
    mocks.storeState.getKnownWorktreeById.mockReset()
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
    mocks.storeState.getKnownWorktreeById.mockReturnValue({
      id: 'wt-empty',
      repoId: 'repo-1',
      hostId: undefined
    })
    mocks.storeState.repos = [{ id: 'repo-1', path: '/repo', connectionId: null }]
    mocks.storeState.settings = { defaultTuiAgent: 'codex' }
    mocks.buildSidebarDefaultAgentStartup.mockReturnValue(startup)

    await activateWorktreeFromSidebar('wt-empty', undefined, { launchDefaultAgent: true })

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
})
