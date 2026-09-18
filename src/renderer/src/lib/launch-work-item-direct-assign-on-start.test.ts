import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const createWorktree = vi.fn()
  const setSidebarOpen = vi.fn()
  return {
    toastError: vi.fn(),
    createWorktree,
    setSidebarOpen,
    activateAndRevealWorktree: vi.fn(),
    openModalFallback: vi.fn(),
    beginDirectWorkItemStructuredLaunch: vi.fn(),
    store: {
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 1 }],
      settings: {
        assignUnassignedGitHubIssuesOnStart: false
      } as { assignUnassignedGitHubIssuesOnStart: boolean },
      createWorktree,
      setSidebarOpen
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => mocks.activateAndRevealWorktree(...args)
}))

vi.mock('@/lib/workspace/creation/work-item/direct-work-item-setup', () => ({
  prepareDirectWorkItemSetup: vi.fn(async () => ({ setupDecision: 'skip' }))
}))

vi.mock('@/lib/workspace/creation/work-item/launch-work-item-direct-draft', () => ({
  getDirectWorkItemIdentity: (item: { type: string; number: number | null }) => ({
    itemType: item.type,
    itemNumber: item.number
  }),
  getDirectWorkItemWorkspaceNames: () => ({
    workspaceIntentName: null,
    workspaceName: 'issue-21047'
  })
}))

vi.mock('@/lib/work-items/linked-work-item-context', () => ({
  getLaunchableWorkItemDraftContent: vi.fn(async () => 'draft')
}))

vi.mock('@/lib/workspace/creation/work-item/launch-work-item-direct-preflight', () => ({
  captureDirectWorkItemLaunchArgs: (args: unknown) => args,
  prepareDirectLaunchContext: () => ({
    repo: { id: 'repo-1', path: '/repo' },
    executionHostId: 'local',
    target: { kind: 'local' },
    shell: 'posix',
    repoConnectionId: null,
    repoLaunchHost: { platform: 'darwin' },
    repoProjectRuntime: undefined,
    projectContextPromise: Promise.resolve({ context: {} })
  }),
  resolveDirectProspectiveAgent: vi.fn(async () => ({
    prospectiveAgent: null,
    unavailable: false
  })),
  planDirectWorkItemLaunch: vi.fn(async () => null),
  directWorkItemAgentArgsError: () => null,
  resolveDirectPrStartPoint: vi.fn()
}))

vi.mock('@/lib/workspace/creation/work-item/launch-work-item-direct-route-preparation', () => ({
  prepareDirectWorkItemAgentLaunch: vi.fn(async () => ({
    unavailable: false,
    effectiveAgent: null,
    startupPlan: null,
    draftLaunchedNatively: false,
    startupPlanFailed: false,
    plan: null,
    structuredLaunch: false
  }))
}))

vi.mock('@/lib/workspace/creation/work-item/launch-work-item-direct-agent-routing', () => ({
  beginDirectWorkItemStructuredLaunch: (...args: unknown[]) =>
    mocks.beginDirectWorkItemStructuredLaunch(...args),
  finishDirectWorkItemPrompt: vi.fn(async () => true),
  directWorkItemStartupAccepted: vi.fn(() => true)
}))

vi.mock('@/lib/workspace/creation/work-item/launch-work-item-direct-agent', () => ({
  buildDirectWorkItemStartupOpts: vi.fn(() => ({}))
}))

vi.mock('@/lib/agent-session/launch/routing/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: vi.fn()
}))

vi.mock('@/lib/agent-session/launch/routing/agent-launch-request-id', () => ({
  newAgentLaunchRequestId: () => 'req-1'
}))

vi.mock('@/lib/agent-session/launch/failure/agent-launch-failure', () => ({
  agentLaunchRecoveryMessage: () => 'recovery'
}))

const mockApi = {
  gh: {
    viewer: vi.fn(),
    updateIssue: vi.fn()
  }
}

const githubIssueItem = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 21047,
  title: 'Assign on start',
  url: 'https://github.com/stablyai/orca/issues/21047'
}

describe('launchWorkItemDirect GitHub start assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: undefined
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.beginDirectWorkItemStructuredLaunch.mockReturnValue({
      structuredLaunch: false,
      completed: true,
      primaryTabId: null
    })
    mocks.store.settings.assignUnassignedGitHubIssuesOnStart = false
    vi.stubGlobal('window', {
      api: mockApi,
      location: { pathname: '/index.html' }
    })
    mockApi.gh.viewer.mockResolvedValue({ login: 'octocat' })
    mockApi.gh.updateIssue.mockResolvedValue({ ok: true })
  })

  async function startGitHubIssue(item: {
    assignees?: readonly { login: string }[]
  }): Promise<boolean | 'cancelled'> {
    const { launchWorkItemDirect } = await import(
      '@/lib/workspace/creation/work-item/launch-work-item-direct'
    )
    return launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      openModalFallback: mocks.openModalFallback,
      item: { ...githubIssueItem, ...item }
    })
  }

  it('assigns the current GitHub user after starting an unassigned issue when the setting is on', async () => {
    mocks.store.settings.assignUnassignedGitHubIssuesOnStart = true

    await expect(startGitHubIssue({ assignees: [] })).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mockApi.gh.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        repoId: 'repo-1',
        number: 21047,
        updates: { addAssignees: ['octocat'] },
        ownerRepo: { host: 'github.com', owner: 'stablyai', repo: 'orca' }
      })
    )
  })

  it('does not assign an already-assigned GitHub issue when starting work', async () => {
    mocks.store.settings.assignUnassignedGitHubIssuesOnStart = true

    await expect(startGitHubIssue({ assignees: [{ login: 'teammate' }] })).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mockApi.gh.updateIssue).not.toHaveBeenCalled()
  })

  it('does not assign when starting work with the setting off', async () => {
    await expect(startGitHubIssue({ assignees: [] })).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mockApi.gh.updateIssue).not.toHaveBeenCalled()
  })

  it('still creates the workspace when assigning the GitHub issue throws', async () => {
    mocks.store.settings.assignUnassignedGitHubIssuesOnStart = true
    mockApi.gh.updateIssue.mockRejectedValue(new Error('Resource not accessible by integration'))

    await expect(startGitHubIssue({ assignees: [] })).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't assign the GitHub issue to you. The workspace was still created."
    )
  })
})
