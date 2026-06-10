import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type * as TuiAgentSelectionModule from '../../../shared/tui-agent-selection'
import type * as TuiAgentStartupModule from '@/lib/tui-agent-startup'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  setSidebarOpen: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  openModalFallback: vi.fn(),
  resolvePrBase: vi.fn(),
  getConnectionId: vi.fn(),
  store: {} as Record<string, unknown> & {
    ensureDetectedAgents: ReturnType<typeof vi.fn>
    ensureRemoteDetectedAgents: ReturnType<typeof vi.fn>
    createWorktree: ReturnType<typeof vi.fn>
    updateWorktreeMeta: ReturnType<typeof vi.fn>
    setSidebarOpen: ReturnType<typeof vi.fn>
  }
}))

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
          displayName:
            args.workItem.type === 'pr'
              ? `Review PR ${args.workItem.number}`
              : `Issue ${args.workItem.number}`,
          seedName:
            args.workItem.type === 'pr'
              ? `review-pr-${args.workItem.number}`
              : `issue-${args.workItem.number}`
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

vi.mock('../../../shared/tui-agent-selection', async () => {
  const actual = await vi.importActual<typeof TuiAgentSelectionModule>(
    '../../../shared/tui-agent-selection'
  )
  return {
    ...actual,
    pickTuiAgent: vi.fn(actual.pickTuiAgent)
  }
})

import { launchWorkItemDirect } from './launch-work-item-direct'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'

const mockApi = {
  worktrees: {
    resolvePrBase: mocks.resolvePrBase
  },
  agentTrust: {
    markTrusted: vi.fn()
  }
}

describe('launchWorkItemDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        worktrees: {
          resolvePrBase: mocks.resolvePrBase
        },
        agentTrust: {
          markTrusted: mockApi.agentTrust.markTrusted
        }
      }
    })
    mocks.resolvePrBase.mockResolvedValue({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
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
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          addedAt: 1
        }
      ],
      settings: {
        defaultTuiAgent: 'codex',
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      },
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
      createWorktree: mocks.createWorktree,
      updateWorktreeMeta: mocks.updateWorktreeMeta,
      setSidebarOpen: mocks.setSidebarOpen
    } as typeof mocks.store
    // @ts-expect-error -- test shim
    globalThis.window = { api: mockApi }
    mockApi.agentTrust.markTrusted.mockResolvedValue(undefined)
  })

  it('rejects invalid per-launch CLI arguments before creating a workspace', async () => {
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentArgs: '--model "unterminated',
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix invalid saved launch args',
          url: 'https://github.com/acme/repo/issues/42'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'CLI arguments are invalid: Unclosed quote in command template.'
    )
  })

  it('passes a resolved PR branch override while using a short PR identity for workspace names', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue([])
    mocks.store.settings = {}
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'pr',
        number: 42,
        title: 'Fix the bug',
        url: 'https://github.com/acme/repo/pull/42'
      }
    })

    expect(mocks.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'review-pr-42',
      'abc123',
      'inherit',
      undefined,
      'sidebar',
      'Review PR 42',
      undefined,
      42,
      { remoteName: 'origin', branchName: 'feature/fix' },
      undefined,
      undefined,
      'feature/fix',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('uses the Linear identifier in direct-launch workspace names', async () => {
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'issue',
        number: null,
        title: 'Ship Linear parity',
        url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
        linearIdentifier: 'ENG-42'
      }
    })

    expect(mocks.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'eng-42-ship-linear-parity',
      undefined,
      'inherit',
      undefined,
      'sidebar',
      'Ship Linear parity',
      undefined,
      undefined,
      undefined,
      undefined,
      'ENG-42',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('uses remote cursor-agent detection, trust preflight, and paste launch for SSH repos', async () => {
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
    mocks.store.settings = { defaultTuiAgent: 'cursor' } as AppState['settings']
    mocks.store.ensureRemoteDetectedAgents.mockResolvedValue(['cursor'])
    vi.mocked(pickTuiAgent).mockReturnValueOnce('cursor')
    vi.mocked(buildAgentDraftLaunchPlan).mockReturnValueOnce(null)
    vi.mocked(buildAgentStartupPlan).mockReturnValueOnce({
      agent: 'cursor',
      launchCommand: 'cursor-agent',
      expectedProcess: 'cursor-agent',
      followupPrompt: null
    })
    mocks.store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-ssh', path: '/home/orca/repo-worktrees/issue-77' }
    })

    await launchWorkItemDirect({
      repoId: 'repo-ssh',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'issue',
        number: 77,
        title: 'Fix cursor direct launch',
        url: 'https://github.com/acme/repo/issues/77'
      }
    })

    expect(mocks.store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mockApi.agentTrust.markTrusted).toHaveBeenCalledWith({
      preset: 'cursor',
      workspacePath: '/home/orca/repo-worktrees/issue-77',
      connectionId: 'ssh-1'
    })
    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith({
      agent: 'cursor',
      draft: 'https://github.com/acme/repo/issues/77',
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(buildAgentStartupPlan).toHaveBeenCalledWith({
      agent: 'cursor',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      content: 'https://github.com/acme/repo/issues/77',
      agent: 'cursor',
      submit: false,
      forcePaste: false,
      onTimeout: expect.any(Function)
    })
  })

  it('does not launch a disabled saved agent even when another agent is available', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['codex', 'claude'])
    mocks.store.settings = {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: ['codex'],
      agentCmdOverrides: {}
    }
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page',
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready'
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
    expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Selected agent is not available in the created workspace.'
    )
  })

  it('plans direct SSH workspace agent startup for the remote host platform', async () => {
    mocks.getConnectionId.mockReturnValue('ssh-1')
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['pi'])
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/home/alice/repo',
        connectionId: 'ssh-1',
        displayName: 'Remote Repo',
        addedAt: 1
      }
    ]
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page',
        agentOverride: 'pi'
      })
    ).resolves.toBe(true)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalled()
    const activationOptions = mocks.activateAndRevealWorktree.mock.calls.at(-1)?.[1]
    expect(activationOptions.startup.command).toContain('unset ORCA_PI_PREFILL')
    expect(activationOptions.startup.command).not.toContain('Remove-Item Env:ORCA_PI_PREFILL')
  })

  it('uses the repo SSH connection when the created worktree is not hydrated yet', async () => {
    mocks.getConnectionId.mockReturnValue(undefined)
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['pi'])
    mocks.store.settings = {
      defaultTuiAgent: 'pi',
      disabledTuiAgents: [],
      agentCmdOverrides: {}
    }
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/home/alice/repo',
        connectionId: 'ssh-1',
        displayName: 'Remote Repo',
        addedAt: 1
      }
    ]
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    const activationOptions = mocks.activateAndRevealWorktree.mock.calls.at(-1)?.[1]
    expect(activationOptions.startup.command).toContain('unset ORCA_PI_PREFILL')
  })
})
