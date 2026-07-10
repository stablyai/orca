import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = {
    settings: { defaultTuiAgent: 'codex' },
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        connectionId: null as string | null
      }
    ],
    worktrees: [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo/wt-1'
      }
    ],
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo/wt-1'
        }
      ]
    },
    projects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Record<string, unknown>[],
    allWorktrees: vi.fn(() => store.worktrees),
    ensureDetectedAgents: vi.fn(),
    ensureRemoteDetectedAgents: vi.fn()
  }
  return {
    store,
    activateAndRevealWorktree: vi.fn(),
    findGithubPrWorkspaceAttachment: vi.fn(),
    focusTerminalTabSurface: vi.fn(),
    getConnectionId: vi.fn(),
    launchAgentInNewTab: vi.fn(),
    launchWorkItemDirect: vi.fn(),
    pickSourceControlLaunchAgent: vi.fn(),
    readSourceControlLaunchRecipeAgentId: vi.fn(),
    resolveSourceControlActionRecipe: vi.fn(),
    resolveSourceControlLaunchPlatform: vi.fn(),
    toastError: vi.fn(),
    toastMessage: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: mocks.toastMessage
  }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/github-work-item-workspace-attachment', () => ({
  findGithubPrWorkspaceAttachment: mocks.findGithubPrWorkspaceAttachment
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/launch-work-item-direct', () => ({
  launchWorkItemDirect: mocks.launchWorkItemDirect
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('@/lib/source-control-launch-agent-selection', () => ({
  pickSourceControlLaunchAgent: mocks.pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId: mocks.readSourceControlLaunchRecipeAgentId
}))

vi.mock('@/lib/source-control-launch-platform', () => ({
  resolveSourceControlLaunchPlatform: mocks.resolveSourceControlLaunchPlatform
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('../../../shared/source-control-ai', () => ({
  resolveSourceControlActionRecipe: mocks.resolveSourceControlActionRecipe
}))

describe('startFixChecksAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        connectionId: null
      }
    ]
    mocks.store.worktrees = [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }]
    mocks.store.worktreesByRepo = { 'repo-1': mocks.store.worktrees }
    mocks.store.projects = [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    mocks.store.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.store.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    mocks.findGithubPrWorkspaceAttachment.mockReturnValue(null)
    mocks.getConnectionId.mockReturnValue(null)
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-1' })
    mocks.launchWorkItemDirect.mockResolvedValue(true)
    mocks.pickSourceControlLaunchAgent.mockImplementation(({ detectedAgents }) => {
      return detectedAgents.includes('codex') ? 'codex' : null
    })
    mocks.readSourceControlLaunchRecipeAgentId.mockReturnValue(null)
    mocks.resolveSourceControlActionRecipe.mockReturnValue({
      commandInputTemplate: '{basePrompt}'
    })
    mocks.resolveSourceControlLaunchPlatform.mockReturnValue('darwin')
  })

  it('fails without launching when the requested worktree is missing', async () => {
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'missing-worktree',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('fails without launching when agent detection finds no enabled agent', async () => {
    mocks.store.ensureDetectedAgents.mockResolvedValue([])
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('rejects without launching when remote agent detection fails', async () => {
    mocks.getConnectionId.mockReturnValue('conn-1')
    mocks.store.ensureRemoteDetectedAgents.mockRejectedValue(new Error('detection failed'))
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).rejects.toThrow('detection failed')

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('falls back to the repo connection when an attached workspace lookup is unresolved', async () => {
    mocks.store.repos = [
      {
        ...mocks.store.repos[0],
        connectionId: 'ssh-1'
      }
    ]
    mocks.getConnectionId.mockReturnValue(undefined)
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.resolveSourceControlLaunchPlatform).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      worktreePath: '/repo/wt-1',
      projectRuntime: undefined
    })
  })

  it('passes the local project runtime when resolving an attached WSL workspace launch platform', async () => {
    mocks.store.repos = [
      {
        ...mocks.store.repos[0],
        path: 'C:\\Users\\alice\\repo'
      }
    ]
    mocks.store.worktrees = [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\Users\\alice\\repo-worktree'
      }
    ]
    mocks.store.worktreesByRepo = { 'repo-1': mocks.store.worktrees }
    mocks.store.projects = [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    mocks.resolveSourceControlLaunchPlatform.mockImplementation(({ projectRuntime }) =>
      projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
        ? 'linux'
        : 'win32'
    )
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.resolveSourceControlLaunchPlatform).toHaveBeenCalledWith({
      connectionId: null,
      worktreePath: 'C:\\Users\\alice\\repo-worktree',
      projectRuntime: expect.objectContaining({
        status: 'resolved',
        runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
      })
    })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ launchPlatform: 'linux' })
    )
  })

  it('fails without launching when the launch platform cannot be resolved', async () => {
    mocks.resolveSourceControlLaunchPlatform.mockReturnValue(undefined)
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('rejects invalid saved CLI arguments before activating the attached workspace', async () => {
    mocks.resolveSourceControlActionRecipe.mockReturnValue({
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model "unterminated'
    })
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'CLI arguments are invalid: Unclosed quote in command template.'
    )
  })

  it('rejects without focusing a terminal when agent launch throws', async () => {
    mocks.launchAgentInNewTab.mockImplementation(() => {
      throw new Error('launch failed')
    })
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).rejects.toThrow('launch failed')

    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
