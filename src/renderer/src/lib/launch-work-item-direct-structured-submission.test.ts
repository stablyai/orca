import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  getConnectionId: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  resolvePrBase: vi.fn(),
  startStructuredAgentLaunch: vi.fn(),
  toastError: vi.fn(),
  store: {} as Record<string, unknown> & {
    createWorktree: ReturnType<typeof vi.fn>
    ensureDetectedAgents: ReturnType<typeof vi.fn>
    ensureRemoteDetectedAgents: ReturnType<typeof vi.fn>
    updateWorktreeMeta: ReturnType<typeof vi.fn>
  }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, message: vi.fn() }
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

vi.mock('@/lib/connection-context', () => ({ getConnectionId: mocks.getConnectionId }))

vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => ['agent-session.structured.v1'],
  refreshLocalRuntimeCapabilities: vi.fn().mockResolvedValue(['agent-session.structured.v1'])
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch
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
  CLIENT_PLATFORM: 'linux',
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

import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { launchWorkItemDirect } from './launch-work-item-direct'

const mockApi = {
  worktrees: { resolvePrBase: mocks.resolvePrBase },
  agentTrust: { markTrusted: vi.fn() }
}

describe('launchWorkItemDirect structured submission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolvePrBase.mockResolvedValue({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'abc123',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.getConnectionId.mockReturnValue(null)
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'structured-session-1',
      launchResult: Promise.resolve({ sessionId: 'structured-session-1', fence: 1 }),
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false }),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: undefined
    })
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
      updateWorktreeMeta: vi.fn().mockResolvedValue(undefined),
      setSidebarOpen: vi.fn(),
      seedNativeChatLaunchPrompt: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      markNativeChatLaunchPromptFailed: vi.fn()
    } as typeof mocks.store
    // @ts-expect-error -- test shim
    globalThis.window = { api: mockApi }
    mockApi.agentTrust.markTrusted.mockResolvedValue(undefined)
  })

  it('uses one structured Codex writer with default native-chat flags off', async () => {
    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 57,
          title: 'Start the native Codex session',
          url: 'https://github.com/OrbittechIA/oroboros-core/issues/57'
        }
      })
    ).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      'codex',
      {
        prompt: 'https://github.com/OrbittechIA/oroboros-core/issues/57',
        promptDelivery: 'submit-after-ready',
        launchOrigin: 'work-item-start'
      }
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealWorktree.mock.calls[0]?.[1]).toMatchObject({
      providesInitialSurface: true
    })
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('reports structured prompt rejection without creating a second writer', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValueOnce({
      sessionId: 'structured-session-1',
      launchResult: Promise.resolve({ sessionId: 'structured-session-1', fence: 1 }),
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false }),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 36,
          title: 'Wait through a trust prompt',
          url: 'https://github.com/acme/repo/issues/36'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The structured agent session did not accept the work item prompt. Orca did not retry or start another writer.'
    )
  })

  it('fails closed instead of launching a configured Codex wrapper', async () => {
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: { codex: 'oroboros-codex-native-start' }
    }

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 57,
          title: 'Do not use the legacy wrapper',
          url: 'https://github.com/OrbittechIA/oroboros-core/issues/57'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree.mock.calls[0]?.[1]).not.toHaveProperty('startup')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Submit after ready requires a local structured Codex or Claude session without custom launch arguments. The workspace was created, but no agent or prompt was started.'
    )
  })

  it('preserves explicit legacy terminal submission for fix-check recipes', async () => {
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: { codex: 'codex --dangerously-bypass-approvals-and-sandbox' }
    }

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'codex',
        agentArgs: '--search',
        promptDelivery: 'submit-after-ready',
        allowLegacyTerminalPromptSubmission: true,
        item: {
          type: 'pr',
          number: 57,
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/57',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(true)

    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree.mock.calls[0]?.[1]).toMatchObject({
      startup: expect.objectContaining({ launchAgent: 'codex' })
    })
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
  })

  it('fails closed on SSH instead of inferring readiness from remote PTY output', async () => {
    mocks.store.repos = [
      {
        id: 'repo-ssh',
        path: '/home/orca/repo',
        displayName: 'Remote Repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-1'
      }
    ] as AppState['repos']
    mocks.store.createWorktree.mockResolvedValue({
      worktree: {
        id: 'repo-ssh::/home/orca/repo-worktrees/issue-57',
        path: '/home/orca/repo-worktrees/issue-57'
      }
    })
    mocks.getConnectionId.mockReturnValue('ssh-1')

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-ssh',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 57,
          title: 'Do not infer remote readiness',
          url: 'https://github.com/OrbittechIA/oroboros-core/issues/57'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
  })
})
