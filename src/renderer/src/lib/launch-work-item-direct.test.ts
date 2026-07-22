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
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
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
    seedNativeChatLaunchPrompt: ReturnType<typeof vi.fn>
    markNativeChatLaunchPromptFailed: ReturnType<typeof vi.fn>
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
      compareBaseRef: 'refs/remotes/origin/main',
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
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
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
        number: 6934,
        title: 'Fix the bug',
        url: 'https://github.com/stablyai/orca/pull/6934',
        branchName: 'feature/fix',
        baseRefName: 'main',
        isCrossRepository: true
      }
    })

    expect(mocks.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo-1',
      prNumber: 6934,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      isCrossRepository: true
    })
    expect(mocks.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'review-pr-6934',
      'abc123',
      'inherit',
      undefined,
      'sidebar',
      'Review PR 6934',
      undefined,
      6934,
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
      undefined,
      undefined,
      undefined,
      undefined,
      'refs/remotes/origin/main'
    )
  })

  it('treats a PR-typed GitHub issue URL as an issue without resolving a PR head', async () => {
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')
    const openModalFallback = vi.fn()

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback,
        item: {
          type: 'pr',
          number: 6933,
          title: 'The board columns are displayed backwards',
          url: 'https://github.com/stablyai/orca/issues/6933',
          branchName: 'fix-issue-6933',
          baseRefName: 'main',
          isCrossRepository: true
        }
      })
    ).resolves.toBe(true)

    expect(mocks.resolvePrBase).not.toHaveBeenCalled()
    expect(openModalFallback).not.toHaveBeenCalled()
    const createArgs = mocks.createWorktree.mock.calls[0]
    expect(createArgs?.[1]).toBe('issue-6933')
    expect(createArgs?.[2]).toBeUndefined()
    expect(createArgs?.[6]).toBe('Issue 6933')
    expect(createArgs?.[7]).toBe(6933)
    expect(createArgs?.[8]).toBeUndefined()
    expect(createArgs?.[9]).toBeUndefined()
    expect(createArgs?.[12]).toBeUndefined()
    expect(createArgs?.[24]).toBeUndefined()
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('prefills a link-only Linear reference without source context', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        item: {
          type: 'issue',
          number: null,
          title: 'Ship Linear parity',
          url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
          linearIdentifier: 'ENG-42',
          linkedContext: {
            provider: 'linear',
            version: 1,
            renderedText: [
              'Linear issue context snapshot',
              'Identifier: ENG-42',
              'Title: Ship Linear parity',
              'Description:',
              'The distinctive Linear body text is here.'
            ].join('\n')
          }
        }
      })
    ).resolves.toBe(true)

    const expectedDraft = [
      'Linked Linear issue: ENG-42',
      'https://linear.app/acme/issue/ENG-42/ship-linear-parity'
    ].join('\n')
    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith({
      agent: 'claude',
      draft: `${expectedDraft}\n`,
      cmdOverrides: {},
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {},
      sessionOptions: undefined,
      platform: 'win32',
      isRemote: false
    })
    expect(buildAgentStartupPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        prompt: '',
        allowEmptyPromptLaunch: true
      })
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: expect.stringContaining('Linked Linear issue: ENG-42')
        })
      })
    )
    const startupCommand = mocks.activateAndRevealWorktree.mock.calls[0]?.[1]?.startup?.command
    expect(startupCommand).toContain('https://linear.app/acme/issue/ENG-42/ship-linear-parity')
    expect(startupCommand).not.toContain('The distinctive Linear body text is here.')
    expect(startupCommand).not.toContain('--- BEGIN LINKED WORK ITEM CONTEXT ---')
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('preserves explicit Linear paste content submit-after-ready behavior', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'claude',
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: null,
          title: 'Ship Linear parity',
          url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
          linearIdentifier: 'ENG-42',
          pasteContent: 'Use this explicit user prompt.',
          linkedContext: {
            provider: 'linear',
            version: 1,
            renderedText: 'This generated Linear source should not replace explicit paste content.'
          }
        }
      })
    ).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).not.toHaveBeenCalled()
    expect(pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'Use this explicit user prompt.',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        onTimeout: expect.any(Function)
      })
    )
    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'Use this explicit user prompt.',
      createdAt: expect.any(Number)
    })
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
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
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
      agentArgs: '--yolo',
      agentEnv: {},
      sessionOptions: undefined,
      platform: 'linux',
      isRemote: true
    })
    expect(buildAgentStartupPlan).toHaveBeenCalledWith({
      agent: 'cursor',
      prompt: '',
      cmdOverrides: {},
      agentArgs: '--yolo',
      agentEnv: {},
      sessionOptions: undefined,
      platform: 'linux',
      isRemote: true,
      allowEmptyPromptLaunch: true
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-ssh',
      expect.objectContaining({
        startup: expect.objectContaining({
          draftPrompt: 'https://github.com/acme/repo/issues/77'
        })
      })
    )
    expect(pasteDraftWhenAgentReady).not.toHaveBeenCalled()
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

  it('plans direct local Windows-path launches with POSIX startup for WSL project runtime', async () => {
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: 'C:\\Users\\alice\\repo',
        displayName: 'Repo',
        addedAt: 1
      }
    ]
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
    mocks.store.createWorktree.mockResolvedValue({
      worktree: {
        id: 'repo-1::C:\\Users\\alice\\repo-worktree',
        path: 'C:\\Users\\alice\\repo-worktree'
      }
    })
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
    ).resolves.toBe(true)

    expect(buildAgentStartupPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        platform: 'linux'
      })
    )
  })
})
