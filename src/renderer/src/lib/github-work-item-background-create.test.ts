import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { GitHubWorkItem, Repo } from '../../../shared/types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentDraftLaunchPlan: vi.fn(() => null),
  buildAgentStartupPlan: vi.fn(() => ({
    agent: 'codex',
    launchCommand: 'codex',
    expectedProcess: 'codex',
    followupPrompt: null,
    launchConfig: { kind: 'shell', command: 'codex' }
  }))
}))

vi.mock('@/lib/telemetry', () => ({
  tuiAgentToAgentKind: (agent: string) => agent
}))

import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { createGitHubWorkItemWorkspaceInBackground } from './github-work-item-background-create'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1
}

function makeRuntimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'runtime-1',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    ...overrides
  }
}

function makeIssue(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'I_42',
    repoId: 'repo-1',
    type: 'issue',
    number: 42,
    title: 'Make issue workspace creation async',
    url: 'https://github.com/stablyai/orca/issues/42',
    state: 'open',
    author: null,
    labels: [],
    assignees: [],
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
    commentsCount: 0,
    ...overrides
  } as GitHubWorkItem
}

function makeStore(overrides: Partial<ReturnType<typeof baseStore>> = {}) {
  return { ...baseStore(), ...overrides }
}

function baseStore() {
  return {
    activeView: 'tasks' as const,
    repos: [repo],
    pendingWorktreeCreations: {},
    sshConnectionStates: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    settings: {
      activeRuntimeEnvironmentId: null,
      defaultTuiAgent: 'codex' as const,
      disabledTuiAgents: []
    },
    ensureDetectedAgents: vi.fn().mockResolvedValue([]),
    ensureRemoteDetectedAgents: vi.fn().mockResolvedValue([]),
    ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue([])
  }
}

function makeDeps(store = makeStore()) {
  return {
    getStore: () => store,
    getActiveView: vi.fn(() => store.activeView),
    hasPendingCreate: vi.fn(() => true),
    isPendingCreateActive: vi.fn(() => true),
    resolveSetupDecision: vi.fn().mockResolvedValue({ kind: 'decided', decision: 'inherit' }),
    resolvePrStartPoint: vi.fn(),
    confirmHooks: vi.fn().mockResolvedValue('run'),
    readIssueCommand: vi.fn().mockResolvedValue({
      effectiveContent: null,
      localContent: null,
      sharedContent: null,
      localFilePath: '',
      source: 'none'
    }),
    beginBackgroundCreate: vi.fn(() => 'creation-1'),
    continueBackgroundCreate: vi.fn(() => true),
    activatePendingCreate: vi.fn(),
    removePendingCreate: vi.fn(),
    setActiveView: vi.fn(),
    toastError: vi.fn()
  }
}

describe('createGitHubWorkItemWorkspaceInBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts a background issue workspace without opening the composer', async () => {
    const deps = makeDeps()
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        telemetrySource: 'sidebar',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'background-started' })
    expect(openModalFallback).not.toHaveBeenCalled()
    expect(deps.beginBackgroundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-1',
        name: 'issue-42-make-issue-workspace',
        displayName: 'Issue 42 Make Issue Workspace',
        linkedIssue: 42,
        telemetrySource: 'sidebar',
        setupDecision: 'inherit',
        agent: null
      })
    )
    expect(deps.continueBackgroundCreate).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        repoId: 'repo-1',
        name: 'issue-42-make-issue-workspace',
        displayName: 'Issue 42 Make Issue Workspace',
        linkedIssue: 42,
        telemetrySource: 'sidebar',
        setupDecision: 'inherit',
        agent: null,
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      }),
      { revealCreationSurface: false }
    )
  })

  it('does not resolve a PR start point for a stale PR-typed issue URL', async () => {
    const deps = makeDeps()

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue({
          type: 'pr',
          number: 6933,
          title: 'The board columns are displayed backwards',
          url: 'https://github.com/stablyai/orca/issues/6933',
          branchName: 'fix-issue-6933',
          baseRefName: 'main',
          isCrossRepository: true
        }),
        repoId: 'repo-1',
        telemetrySource: 'sidebar',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(deps.resolvePrStartPoint).not.toHaveBeenCalled()
    const beginCalls = deps.beginBackgroundCreate.mock.calls as unknown as [
      WorktreeCreationRequest
    ][]
    expect(beginCalls[0]?.[0].linkedIssue).toBe(6933)
    expect(beginCalls[0]?.[0].linkedPR).toBeUndefined()
    const continueCalls = deps.continueBackgroundCreate.mock.calls as unknown as [
      string,
      WorktreeCreationRequest
    ][]
    const request = continueCalls[0]?.[1]
    expect(request?.linkedIssue).toBe(6933)
    expect(request?.linkedPR).toBeUndefined()
    expect(request?.baseBranch).toBeUndefined()
    expect(request?.pushTarget).toBeUndefined()
    expect(request?.branchNameOverride).toBeUndefined()
    expect(request?.compareBaseRef).toBeUndefined()
  })

  it('shows the pending workspace before async preflight resolves', async () => {
    let resolveSetupDecision: ((value: { kind: 'decided'; decision: 'inherit' }) => void) | null =
      null
    const deps = makeDeps()
    deps.resolveSetupDecision.mockImplementation(
      () =>
        new Promise<{ kind: 'decided'; decision: 'inherit' }>((resolve) => {
          resolveSetupDecision = resolve
        })
    )

    const pending = createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(deps.beginBackgroundCreate).toHaveBeenCalledTimes(1)
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()

    expect(resolveSetupDecision).not.toBeNull()
    resolveSetupDecision!({ kind: 'decided', decision: 'inherit' })
    await pending

    expect(deps.continueBackgroundCreate).toHaveBeenCalledTimes(1)
  })

  it('reuses an existing pending issue create instead of staging a duplicate', async () => {
    const pendingRequest: WorktreeCreationRequest = {
      repoId: 'repo-1',
      name: 'issue-42-make-issue-workspace',
      setupDecision: 'inherit',
      linkedIssue: 42,
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
    const deps = makeDeps(
      makeStore({
        pendingWorktreeCreations: {
          'creation-existing': {
            creationId: 'creation-existing',
            phase: 'preparing',
            status: 'creating',
            indeterminate: false,
            loaderVisible: true,
            request: pendingRequest
          }
        }
      })
    )

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(result).toEqual({ kind: 'background-started' })
    expect(deps.activatePendingCreate).toHaveBeenCalledWith('creation-existing')
    expect(deps.beginBackgroundCreate).not.toHaveBeenCalled()
    expect(deps.resolveSetupDecision).not.toHaveBeenCalled()
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('falls back without staging when the SSH repo is disconnected', async () => {
    const sshRepo: Repo = {
      ...repo,
      connectionId: 'devbox'
    }
    const deps = makeDeps(
      makeStore({
        repos: [sshRepo],
        sshConnectionStates: new Map([['devbox', { status: 'disconnected' }]])
      })
    )
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'fallback', reason: 'host-unavailable' })
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(deps.beginBackgroundCreate).not.toHaveBeenCalled()
    expect(deps.resolveSetupDecision).not.toHaveBeenCalled()
    expect(deps.confirmHooks).not.toHaveBeenCalled()
  })

  it('falls back without staging when the runtime repo is unreachable', async () => {
    const runtimeRepo: Repo = {
      ...repo,
      executionHostId: 'runtime:env-1'
    }
    const deps = makeDeps(
      makeStore({
        repos: [runtimeRepo],
        runtimeStatusByEnvironmentId: new Map([['env-1', { status: null, checkedAt: 1 }]])
      })
    )
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'fallback', reason: 'host-unavailable' })
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(deps.beginBackgroundCreate).not.toHaveBeenCalled()
    expect(deps.resolveSetupDecision).not.toHaveBeenCalled()
    expect(deps.confirmHooks).not.toHaveBeenCalled()
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('falls back without staging when the runtime host platform is unknown', async () => {
    const runtimeRepo: Repo = {
      ...repo,
      executionHostId: 'runtime:env-1'
    }
    const deps = makeDeps(
      makeStore({
        repos: [runtimeRepo],
        runtimeStatusByEnvironmentId: new Map([
          ['env-1', { status: makeRuntimeStatus({ runtimeId: 'runtime-env-1' }), checkedAt: 1 }]
        ])
      })
    )
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'fallback', reason: 'host-unavailable' })
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(deps.beginBackgroundCreate).not.toHaveBeenCalled()
    expect(deps.resolveSetupDecision).not.toHaveBeenCalled()
    expect(deps.confirmHooks).not.toHaveBeenCalled()
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('uses the preferred quick agent when one is available', async () => {
    const store = makeStore({
      ensureDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    const deps = makeDeps(store)

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.agent).toBe('codex')
    expect(request.startupPlan?.launchCommand).toBe('codex')
    expect(request.startup).toBeUndefined()
    expect(request.quickTelemetry).toEqual({
      agent_kind: 'codex',
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    })
    expect(buildAgentStartupPlan).toHaveBeenCalled()
  })

  it('uses runtime-owned detection and indeterminate progress for runtime repos', async () => {
    const runtimeRepo: Repo = {
      ...repo,
      executionHostId: 'runtime:env-1'
    }
    const store = makeStore({
      repos: [runtimeRepo],
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          {
            status: makeRuntimeStatus({ runtimeId: 'runtime-env-1', hostPlatform: 'win32' }),
            checkedAt: 1
          }
        ]
      ]),
      ensureDetectedAgents: vi.fn().mockResolvedValue([]),
      ensureRemoteDetectedAgents: vi.fn().mockResolvedValue([]),
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    const deps = makeDeps(store)

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(store.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(deps.beginBackgroundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeCreateProgressMode: 'indeterminate',
        workspaceRunContext: expect.objectContaining({
          hostId: 'runtime:env-1',
          repoId: 'repo-1'
        })
      })
    )
    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.worktreeCreateProgressMode).toBe('indeterminate')
    expect(request.agent).toBe('codex')
    expect(buildAgentStartupPlan).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'win32' })
    )
  })

  it('falls back before creating when the selected agent startup plan cannot be built', async () => {
    vi.mocked(buildAgentStartupPlan).mockReturnValueOnce(null)
    const store = makeStore({
      ensureDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    const deps = makeDeps(store)
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'fallback', reason: 'agent-startup' })
    expect(deps.toastError).toHaveBeenCalledWith('Could not build the agent launch command.')
    expect(deps.removePendingCreate).toHaveBeenCalledWith('creation-1')
    expect(deps.setActiveView).toHaveBeenCalledWith('tasks')
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('stops before opening the composer when the staged create is cancelled during setup preflight', async () => {
    let resolveSetupDecision: ((value: { kind: 'needs-modal' }) => void) | null = null
    const deps = makeDeps()
    deps.resolveSetupDecision.mockImplementation(
      () =>
        new Promise<{ kind: 'needs-modal' }>((resolve) => {
          resolveSetupDecision = resolve
        })
    )
    const openModalFallback = vi.fn()

    const pending = createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    deps.hasPendingCreate.mockReturnValue(false)
    expect(resolveSetupDecision).not.toBeNull()
    resolveSetupDecision!({ kind: 'needs-modal' })

    expect(await pending).toEqual({ kind: 'background-started' })
    expect(openModalFallback).not.toHaveBeenCalled()
    expect(deps.removePendingCreate).not.toHaveBeenCalled()
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('stops before hook trust and agent detection when the staged create is cancelled', async () => {
    let resolveSetupDecision: ((value: { kind: 'decided'; decision: 'inherit' }) => void) | null =
      null
    const deps = makeDeps()
    deps.resolveSetupDecision.mockImplementation(
      () =>
        new Promise<{ kind: 'decided'; decision: 'inherit' }>((resolve) => {
          resolveSetupDecision = resolve
        })
    )

    const pending = createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    deps.hasPendingCreate.mockReturnValue(false)
    expect(resolveSetupDecision).not.toBeNull()
    resolveSetupDecision!({ kind: 'decided', decision: 'inherit' })

    expect(await pending).toEqual({ kind: 'background-started' })
    expect(deps.confirmHooks).not.toHaveBeenCalled()
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('falls back to the composer when setup policy requires an explicit choice', async () => {
    const deps = makeDeps()
    deps.resolveSetupDecision.mockResolvedValueOnce({ kind: 'needs-modal' })
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'fallback', reason: 'setup-ask' })
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(deps.removePendingCreate).toHaveBeenCalledWith('creation-1')
    expect(deps.setActiveView).toHaveBeenCalledWith('tasks')
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('leaves the current view alone on fallback after the user leaves the staged create', async () => {
    const deps = makeDeps()
    deps.resolveSetupDecision.mockResolvedValueOnce({ kind: 'needs-modal' })
    deps.isPendingCreateActive.mockReturnValueOnce(false)

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(deps.removePendingCreate).toHaveBeenCalledWith('creation-1')
    expect(deps.setActiveView).not.toHaveBeenCalled()
  })

  it('falls back to the composer when PR start point cannot be resolved', async () => {
    const deps = makeDeps()
    deps.resolvePrStartPoint.mockRejectedValueOnce(new Error('No PR head'))
    const openModalFallback = vi.fn()

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue({ type: 'pr', number: 7, url: 'https://github.com/stablyai/orca/pull/7' }),
        repoId: 'repo-1',
        openModalFallback
      },
      deps
    )

    expect(result).toEqual({ kind: 'fallback', reason: 'pr-start-point' })
    expect(deps.toastError).toHaveBeenCalledWith('No PR head')
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(deps.removePendingCreate).toHaveBeenCalledWith('creation-1')
    expect(deps.setActiveView).toHaveBeenCalledWith('tasks')
    expect(deps.continueBackgroundCreate).not.toHaveBeenCalled()
  })

  it('includes resolved PR start-point data in the background request', async () => {
    const deps = makeDeps()
    deps.resolvePrStartPoint.mockResolvedValueOnce({
      baseBranch: 'feature/from-pr',
      pushTarget: { remote: 'origin', branch: 'feature/from-pr' },
      branchNameOverride: 'feature/from-pr',
      compareBaseRef: 'main'
    })

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue({
          type: 'pr',
          number: 6934,
          url: 'https://github.com/stablyai/orca/pull/6934',
          branchName: 'fix-issue-6933',
          baseRefName: 'main',
          isCrossRepository: true
        }),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(deps.resolvePrStartPoint).toHaveBeenCalledWith(
      'repo-1',
      6934,
      expect.anything(),
      expect.objectContaining({
        type: 'pr',
        number: 6934,
        branchName: 'fix-issue-6933',
        baseRefName: 'main',
        isCrossRepository: true
      })
    )
    expect(deps.continueBackgroundCreate).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        linkedPR: 6934,
        baseBranch: 'feature/from-pr',
        pushTarget: { remote: 'origin', branch: 'feature/from-pr' },
        branchNameOverride: 'feature/from-pr',
        compareBaseRef: 'main'
      }),
      { revealCreationSurface: false }
    )
  })

  it('prefers native draft startup when the agent supports it', async () => {
    vi.mocked(buildAgentDraftLaunchPlan).mockReturnValueOnce({
      agent: 'codex',
      launchCommand: 'codex --prompt-file',
      expectedProcess: 'codex',
      launchConfig: { agentCommand: 'codex', agentArgs: '--prompt-file', agentEnv: {} }
    })
    const store = makeStore({
      ensureDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    const deps = makeDeps(store)

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.startupPlan?.launchCommand).toBe('codex --prompt-file')
    expect(request.startup?.command).toBe('codex --prompt-file')
    expect(buildAgentStartupPlan).not.toHaveBeenCalled()
  })

  it('attaches the rendered issue command when the repo configured one and trust runs', async () => {
    const deps = makeDeps()
    deps.readIssueCommand.mockResolvedValueOnce({
      effectiveContent: 'gh issue view {{issue}} --repo {{artifact_url}}',
      localContent: null,
      sharedContent: 'gh issue view {{issue}} --repo {{artifact_url}}',
      localFilePath: '',
      source: 'shared'
    })

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(deps.confirmHooks).toHaveBeenCalledWith(expect.anything(), 'repo-1', 'setup')
    expect(deps.confirmHooks).toHaveBeenCalledWith(expect.anything(), 'repo-1', 'issueCommand')
    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.issueCommand?.command).toBe(
      'gh issue view 42 --repo https://github.com/stablyai/orca/issues/42'
    )
  })

  it('omits the issue command when the repo configured none', async () => {
    const deps = makeDeps()

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.issueCommand).toBeUndefined()
    expect(deps.confirmHooks).not.toHaveBeenCalledWith(expect.anything(), 'repo-1', 'issueCommand')
  })

  it('skips the issue command when setup trust was declined', async () => {
    const deps = makeDeps()
    deps.readIssueCommand.mockResolvedValueOnce({
      effectiveContent: 'echo {{issue}}',
      localContent: 'echo {{issue}}',
      sharedContent: null,
      localFilePath: '/repo/.orca/issue-command',
      source: 'local'
    })
    // Why: the setup confirmHooks call resolves 'skip', which mirrors the
    // composer suppressing the issue command when setup trust is declined.
    deps.confirmHooks.mockResolvedValue('skip')

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.issueCommand).toBeUndefined()
    expect(deps.confirmHooks).not.toHaveBeenCalledWith(expect.anything(), 'repo-1', 'issueCommand')
    // Why: a declined setup trust short-circuits before the (up-to-15s) read,
    // so workspace creation is never stalled to fetch a command we will drop.
    expect(deps.readIssueCommand).not.toHaveBeenCalled()
  })

  it('does not run the issue command for PR items', async () => {
    const deps = makeDeps()
    deps.resolvePrStartPoint.mockResolvedValueOnce({
      baseBranch: 'feature/from-pr',
      pushTarget: { remote: 'origin', branch: 'feature/from-pr' },
      branchNameOverride: 'feature/from-pr',
      compareBaseRef: 'main'
    })
    deps.readIssueCommand.mockResolvedValueOnce({
      effectiveContent: 'echo {{issue}}',
      localContent: 'echo {{issue}}',
      sharedContent: null,
      localFilePath: '/repo/.orca/issue-command',
      source: 'local'
    })

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue({ type: 'pr', number: 7, url: 'https://github.com/stablyai/orca/pull/7' }),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.issueCommand).toBeUndefined()
    expect(deps.confirmHooks).not.toHaveBeenCalledWith(expect.anything(), 'repo-1', 'issueCommand')
  })

  it('fails closed when reading the issue command rejects', async () => {
    const deps = makeDeps()
    deps.readIssueCommand.mockRejectedValueOnce(new Error('runtime offline'))

    const result = await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    expect(result).toEqual({ kind: 'background-started' })
    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    expect(request.issueCommand).toBeUndefined()
  })

  it('re-reads the store for each trust check so mid-flow trust updates are honored', async () => {
    const snapshots = [makeStore(), makeStore(), makeStore()]
    let getStoreCall = 0
    const deps = makeDeps(snapshots[0])
    deps.getStore = vi.fn(
      () => snapshots[Math.min(getStoreCall++, snapshots.length - 1)] ?? snapshots[0]
    )
    deps.readIssueCommand.mockResolvedValueOnce({
      effectiveContent: 'echo {{issue}}',
      localContent: null,
      sharedContent: 'echo {{issue}}',
      localFilePath: '',
      source: 'shared'
    })

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    // Why: an "Always trust" stamped by the setup prompt only exists in a fresh
    // snapshot. Each trust check must read the store at call time instead of
    // reusing the snapshot captured when the flow began.
    const setupCall = deps.confirmHooks.mock.calls.find((call) => call[2] === 'setup')
    const issueCall = deps.confirmHooks.mock.calls.find((call) => call[2] === 'issueCommand')
    expect(setupCall?.[0]).toBeDefined()
    expect(issueCall?.[0]).toBeDefined()
    expect(setupCall?.[0]).not.toBe(snapshots[0])
    expect(issueCall?.[0]).not.toBe(snapshots[0])
    expect(issueCall?.[0]).not.toBe(setupCall?.[0])
  })

  it('keeps the seeded agent prompt as the bare issue URL (not Complete <url>)', async () => {
    const store = makeStore({
      ensureDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    const deps = makeDeps(store)
    deps.readIssueCommand.mockResolvedValueOnce({
      effectiveContent: 'echo {{issue}}',
      localContent: 'echo {{issue}}',
      sharedContent: null,
      localFilePath: '/repo/.orca/issue-command',
      source: 'local'
    })

    await createGitHubWorkItemWorkspaceInBackground(
      {
        item: makeIssue(),
        repoId: 'repo-1',
        openModalFallback: vi.fn()
      },
      deps
    )

    const continueCall = deps.continueBackgroundCreate.mock.calls[0] as unknown[] | undefined
    expect(continueCall).toBeDefined()
    const request = continueCall?.[1] as WorktreeCreationRequest
    // Why: Brennan's confirmed scope keeps the quick-start prompt the bare link;
    // the issue command runs as a side-pane split, not as the agent prompt.
    expect(request.startupPlan?.draftPrompt).toBe('https://github.com/stablyai/orca/issues/42')
    expect(request.startupPlan?.draftPrompt ?? '').not.toContain('Complete')
    expect(request.quickPrompt).not.toContain('Complete')
    // The issue command itself still threads through as a side-pane split.
    expect(request.issueCommand?.command).toBe('echo 42')
  })
})
