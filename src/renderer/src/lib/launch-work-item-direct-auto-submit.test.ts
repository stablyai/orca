import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TuiAgentStartupModule from '@/lib/tui-agent-startup'

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  setSidebarOpen: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  resolvePrBase: vi.fn(),
  getConnectionId: vi.fn(),
  store: {} as Record<string, unknown> & {
    ensureDetectedAgents: ReturnType<typeof vi.fn>
    ensureRemoteDetectedAgents: ReturnType<typeof vi.fn>
    createWorktree: ReturnType<typeof vi.fn>
    updateWorktreeMeta: ReturnType<typeof vi.fn>
    setSidebarOpen: ReturnType<typeof vi.fn>
    seedNativeChatLaunchPrompt: ReturnType<typeof vi.fn>
    seedNativeChatLaunchDraft: ReturnType<typeof vi.fn>
    markNativeChatLaunchPromptFailed: ReturnType<typeof vi.fn>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn() }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run')
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
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

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32',
  getWorkspaceIntentName: (args: {
    workItem?: { type: 'issue' | 'pr' | 'mr'; number: number; title: string } | null
  }) =>
    args.workItem
      ? {
          displayName: `Issue ${args.workItem.number}`,
          seedName: `issue-${args.workItem.number}`
        }
      : null,
  getSetupConfig: vi.fn(() => null),
  getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? '',
  isGitLabIssueUrl: vi.fn(() => false)
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/tui-agent-startup', async () => {
  const actual = await vi.importActual<typeof TuiAgentStartupModule>('@/lib/tui-agent-startup')
  return {
    ...actual,
    buildAgentDraftLaunchPlan: vi.fn(actual.buildAgentDraftLaunchPlan),
    buildAgentStartupPlan: vi.fn(actual.buildAgentStartupPlan)
  }
})

import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { launchWorkItemDirect } from './launch-work-item-direct'

const mockApi = {
  worktrees: { resolvePrBase: mocks.resolvePrBase },
  agentTrust: { markTrusted: vi.fn() }
}

describe('launchWorkItemDirect auto-submit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.getConnectionId.mockReturnValue(null)
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: undefined
    })
    mocks.updateWorktreeMeta.mockResolvedValue(undefined)
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
    mocks.store = {
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 1 }],
      activeRepoId: 'repo-1',
      activeWorktreeId: null,
      projects: [
        {
          id: 'repo-1',
          displayName: 'Repo',
          badgeColor: '#000000',
          sourceRepoIds: ['repo-1'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      worktreesByRepo: {},
      settings: {
        defaultTuiAgent: 'codex',
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      },
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
      createWorktree: mocks.createWorktree,
      updateWorktreeMeta: mocks.updateWorktreeMeta,
      setSidebarOpen: mocks.setSidebarOpen,
      seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
    } as typeof mocks.store
    // @ts-expect-error -- focused test shim
    globalThis.window = { api: mockApi }
    mockApi.agentTrust.markTrusted.mockResolvedValue(undefined)
  })

  it('reports success only after one prompt reaches the real Codex tab', async () => {
    let resolveDelivery: (delivered: boolean) => void = () => {}
    mocks.pasteDraftWhenAgentReady.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveDelivery = resolve
      })
    )

    let settled = false
    const result = launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      promptDelivery: 'submit-after-ready',
      item: {
        type: 'issue',
        number: 36,
        title: 'Start the agent after readiness',
        url: 'https://github.com/acme/repo/issues/36'
      }
    }).then((value) => {
      settled = true
      return value
    })

    await vi.waitFor(() => expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
      createdWithAgent: 'codex'
    })
    expect(mocks.activateAndRevealWorktree.mock.calls[0]?.[1]?.startup).toEqual(
      expect.objectContaining({
        command: expect.stringContaining('codex'),
        launchAgent: 'codex'
      })
    )
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'https://github.com/acme/repo/issues/36',
        agent: 'codex',
        submit: true,
        forcePaste: true
      })
    )

    resolveDelivery(true)
    await expect(result).resolves.toBe(true)
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
  })

  it('does not report success when no ready input accepts the prompt', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValueOnce(false)

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 36,
          title: 'Wait through update prompts',
          url: 'https://github.com/acme/repo/issues/36'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
  })

  it('keeps startup and delivery on the SSH runtime owner', async () => {
    mocks.getConnectionId.mockReturnValue(undefined)
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/home/alice/repo',
        connectionId: 'ssh-1',
        displayName: 'Remote Repo',
        addedAt: 1
      }
    ]
    mocks.store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-ssh', path: '/home/alice/repo-worktrees/issue-36' }
    })

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Start Codex on the repository owner',
          url: 'https://github.com/acme/repo/issues/36',
          type: 'issue',
          number: 36
        },
        repoId: 'repo-1',
        openModalFallback: vi.fn(),
        launchSource: 'task_page',
        promptDelivery: 'submit-after-ready'
      })
    ).resolves.toBe(true)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(buildAgentStartupPlan).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', platform: 'linux', isRemote: true })
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-ssh',
      expect.objectContaining({
        startup: expect.objectContaining({ launchAgent: 'codex' })
      })
    )
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        agent: 'codex',
        submit: true,
        forcePaste: true
      })
    )
  })
})
