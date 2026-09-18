import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => {
  const createWorktree = vi.fn()
  const ensureDetectedAgents = vi.fn()
  const ensureRemoteDetectedAgents = vi.fn()
  const setSidebarOpen = vi.fn()
  return {
    toastError: vi.fn(),
    createWorktree,
    ensureDetectedAgents,
    ensureRemoteDetectedAgents,
    setSidebarOpen,
    activateAndRevealWorktree: vi.fn(),
    openModalFallback: vi.fn(),
    store: {
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 1 }],
      activeRepoId: 'repo-1',
      activeWorktreeId: null,
      projects: [],
      worktreesByRepo: {},
      settings: {
        defaultTuiAgent: 'codex',
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        assignUnassignedGitHubIssuesOnStart: false
      },
      ensureDetectedAgents,
      ensureRemoteDetectedAgents,
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

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run')
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn().mockReturnValue(null)
}))

vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi
    .fn()
    .mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: vi.fn().mockReturnValue({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/lib/new-workspace', async () => {
  const actual = await vi.importActual<typeof NewWorkspaceModule>('@/lib/new-workspace')
  return {
    ...actual,
    CLIENT_PLATFORM: 'darwin',
    getSetupConfig: vi.fn(() => null),
    getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? '',
    getWorkspaceIntentName: (args: {
      workItem?: { type: 'issue' | 'pr' | 'mr'; number: number; title: string } | null
    }) =>
      args.workItem
        ? {
            displayName: `Issue ${args.workItem.number}`,
            seedName: `issue-${args.workItem.number}`
          }
        : null
  }
})

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  planAgentCliArgsSuffix: () => ({ ok: true, suffix: '' }),
  buildAgentDraftLaunchPlan: vi.fn(() => null),
  buildAgentStartupPlan: vi.fn(() => null)
}))

vi.mock('@/lib/launch-work-item-direct-agent-routing', () => ({
  beginDirectWorkItemStructuredLaunch: vi.fn(() => ({
    structuredLaunch: false,
    completed: false,
    primaryTabId: null
  }))
}))

vi.mock('@/lib/launch-work-item-direct-agent', () => ({
  buildDirectWorkItemStartupOpts: vi.fn(() => ({})),
  notifyDirectWorkItemAgentStartTimeout: vi.fn()
}))

vi.mock('@/lib/launch-work-item-direct-draft', () => ({
  getDirectWorkItemDraftContent: vi.fn().mockResolvedValue('draft')
}))

vi.mock('@/lib/launch-work-item-direct-preflight', () => ({
  resolveDirectPrStartPoint: vi.fn(),
  resolveDirectSetupDecision: vi.fn().mockResolvedValue({ kind: 'ready', decision: 'skip' })
}))

vi.mock('@/lib/launch-work-item-direct-route-preparation', () => ({
  prepareDirectWorkItemAgentLaunch: vi.fn().mockResolvedValue({
    unavailable: false,
    effectiveAgent: null,
    startupPlan: null,
    draftLaunchedNatively: false,
    startupPlanFailed: false,
    plan: null,
    structuredLaunch: false
  })
}))

vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: vi.fn()
}))

vi.mock('@/lib/repo-runtime-owner', () => ({
  getSettingsForRepoRuntimeOwner: vi.fn((state: { settings?: unknown }) => state.settings)
}))

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalRepoProjectExecutionRuntimeContext: vi.fn()
}))

vi.mock('@/lib/source-control-launch-platform', () => ({
  resolveSourceControlLaunchPlatform: vi.fn(() => 'darwin')
}))

const mockApi = {
  worktrees: { resolvePrBase: vi.fn() },
  agentTrust: { markTrusted: vi.fn() },
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
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: undefined
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.store.settings.assignUnassignedGitHubIssuesOnStart = false
    vi.stubGlobal('window', { api: mockApi })
    mockApi.gh.viewer.mockResolvedValue({ login: 'octocat' })
    mockApi.gh.updateIssue.mockResolvedValue({ ok: true })
  })

  async function startGitHubIssue(item: {
    assignees?: readonly { login: string }[]
  }): Promise<boolean> {
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')
    return launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      openModalFallback: mocks.openModalFallback,
      item: { ...githubIssueItem, ...item }
    })
  }

  it('assigns the current GitHub user after starting an unassigned issue when the setting is on', async () => {
    mocks.store.settings = {
      ...mocks.store.settings,
      assignUnassignedGitHubIssuesOnStart: true
    }

    await expect(startGitHubIssue({ assignees: [] })).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mockApi.gh.updateIssue).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: undefined,
      number: 21047,
      updates: { addAssignees: ['octocat'] }
    })
  })

  it('does not assign an already-assigned GitHub issue when starting work', async () => {
    mocks.store.settings = {
      ...mocks.store.settings,
      assignUnassignedGitHubIssuesOnStart: true
    }

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
    mocks.store.settings = {
      ...mocks.store.settings,
      assignUnassignedGitHubIssuesOnStart: true
    }
    mockApi.gh.updateIssue.mockRejectedValue(new Error('Resource not accessible by integration'))

    await expect(startGitHubIssue({ assignees: [] })).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't assign the GitHub issue to you. The workspace was still created."
    )
  })
})
