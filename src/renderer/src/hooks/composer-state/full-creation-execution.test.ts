// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useFullCreationExecution,
  type FullCreationExecutionInput
} from './full-creation-execution'
import type { PreparedFullSubmit } from './composer-submit-model'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type * as FullCreationStructuredLaunchModule from './full-creation-structured-launch'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  planAgentSessionLaunch: vi.fn(),
  queueStandaloneSetupTab: vi.fn(),
  registerWorkspaceSurfaceProducer: vi.fn(),
  settleFullCreationStructuredLaunch: vi.fn(),
  store: {
    settings: {},
    reconcileWorktreeTabModel: vi.fn()
  },
  surfaceProducer: {
    attempt: {
      id: 'full-creation-structured-attempt',
      workspaceKey: 'repo-1::/repo/worktree',
      executionHostId: 'local',
      result: Promise.resolve({ kind: 'failed' as const, reason: 'setup queue failed' })
    },
    materialized: vi.fn(),
    declined: vi.fn(),
    failed: vi.fn(),
    unverifiable: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('./full-creation-structured-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof FullCreationStructuredLaunchModule>()),
  settleFullCreationStructuredLaunch: mocks.settleFullCreationStructuredLaunch
}))

vi.mock('@/lib/workspace-surface-production', () => ({
  registerWorkspaceSurfaceProducer: mocks.registerWorkspaceSurfaceProducer
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))

vi.mock('@/lib/worktree-setup-issue-command-queue', () => ({
  queueStandaloneSetupTab: mocks.queueStandaloneSetupTab
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useFullCreationExecution cancellation', () => {
  it('does not create after dismissal while the late startup-policy preflight is pending', async () => {
    const startupPolicy = deferred<boolean>()
    let cancelled = false
    const createWorktree = vi.fn<FullCreationExecutionInput['createWorktree']>()
    const prepared = {
      submitLinkedWorkItem: null,
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: {
        workspaceName: 'workspace',
        displayName: undefined
      },
      workspaceName: 'workspace',
      nameWasGenerated: false,
      submitBaseBranch: 'main',
      submitCompareBaseRef: undefined,
      submitPushTarget: undefined,
      submitBranchNameOverride: undefined,
      submitLinkedWorkItemProvider: null,
      submitStartupPrompt: '',
      submitShouldRunIssueAutomation: false,
      effectiveSetupDecision: 'skip',
      issueCommandTrustDecision: 'skip',
      confirmedIssueCommandTemplate: '',
      linkedLinearIssue: undefined,
      linkedLinearIssueWorkspaceId: undefined,
      linkedLinearIssueOrganizationUrlKey: undefined,
      effectiveBranchNameOverride: undefined,
      createDisplayName: undefined,
      pendingFirstAgentMessageRename: false,
      startupPlan: null,
      shouldSeedInitialAgentStatus: false,
      composerTelemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      },
      backendStartup: undefined
    } satisfies PreparedFullSubmit
    const persistSetupAgentStartupPolicy = vi.fn(() => startupPolicy.promise)
    const state = {
      applyWorktreeMeta: vi
        .fn<FullCreationExecutionInput['applyWorktreeMeta']>()
        .mockResolvedValue(),
      clearNewWorkspaceDraft: vi.fn<FullCreationExecutionInput['clearNewWorkspaceDraft']>(),
      createWorktree,
      effectivePresetId: null,
      isSubmissionCancelled: () => cancelled,
      linkedGitLabIssue: null,
      linkedGitLabMR: null,
      normalizedSparseDirectories: [],
      note: '',
      onCreated: vi.fn<NonNullable<FullCreationExecutionInput['onCreated']>>(),
      parentWorktreeId: null,
      persistDraft: false,
      persistSetupAgentStartupPolicy,
      prepareFullSubmit: vi
        .fn<FullCreationExecutionInput['prepareFullSubmit']>()
        .mockResolvedValue(prepared),
      resolvedInitialWorkspaceStatus: undefined,
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      setSidebarOpen: vi.fn<FullCreationExecutionInput['setSidebarOpen']>(),
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined,
      tuiAgent: 'claude'
    } satisfies FullCreationExecutionInput
    const hook = renderHook(() => useFullCreationExecution(state))

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    })
    await act(() => Promise.resolve())
    expect(persistSetupAgentStartupPolicy).toHaveBeenCalledTimes(1)

    cancelled = true
    startupPolicy.resolve(true)
    await act(async () => creation)

    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('settles structured surface ownership when post-registration setup throws', async () => {
    const prepared = {
      submitLinkedWorkItem: null,
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: {
        workspaceName: 'workspace',
        displayName: undefined
      },
      workspaceName: 'workspace',
      nameWasGenerated: false,
      submitBaseBranch: 'main',
      submitCompareBaseRef: undefined,
      submitPushTarget: undefined,
      submitBranchNameOverride: undefined,
      submitLinkedWorkItemProvider: null,
      submitStartupPrompt: '',
      submitShouldRunIssueAutomation: false,
      effectiveSetupDecision: 'skip',
      issueCommandTrustDecision: 'skip',
      confirmedIssueCommandTemplate: '',
      linkedLinearIssue: undefined,
      linkedLinearIssueWorkspaceId: undefined,
      linkedLinearIssueOrganizationUrlKey: undefined,
      effectiveBranchNameOverride: undefined,
      createDisplayName: undefined,
      pendingFirstAgentMessageRename: false,
      startupPlan: null,
      shouldSeedInitialAgentStatus: false,
      composerTelemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      },
      backendStartup: undefined
    } satisfies PreparedFullSubmit
    const created = {
      worktree: {
        id: 'repo-1::/repo/worktree',
        repoId: 'repo-1',
        displayName: 'workspace',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        path: '/repo/worktree',
        head: 'abc123',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      },
      setup: {
        runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
        envVars: {}
      }
    } satisfies CreateWorktreeResult
    const structuredPlan = {
      route: 'structured-native-chat',
      agent: 'claude',
      prompt: '',
      launch: vi.fn()
    } satisfies AgentSessionLaunchPlan
    const createWorktree = vi
      .fn<FullCreationExecutionInput['createWorktree']>()
      .mockResolvedValue(created)
    const state = {
      applyWorktreeMeta: vi
        .fn<FullCreationExecutionInput['applyWorktreeMeta']>()
        .mockResolvedValue(),
      clearNewWorkspaceDraft: vi.fn<FullCreationExecutionInput['clearNewWorkspaceDraft']>(),
      createWorktree,
      effectivePresetId: null,
      isSubmissionCancelled: () => false,
      linkedGitLabIssue: null,
      linkedGitLabMR: null,
      normalizedSparseDirectories: [],
      note: '',
      onCreated: vi.fn<NonNullable<FullCreationExecutionInput['onCreated']>>(),
      parentWorktreeId: null,
      persistDraft: false,
      persistSetupAgentStartupPolicy: vi.fn(async () => true),
      prepareFullSubmit: vi
        .fn<FullCreationExecutionInput['prepareFullSubmit']>()
        .mockResolvedValue(prepared),
      resolvedInitialWorkspaceStatus: undefined,
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      setSidebarOpen: vi.fn<FullCreationExecutionInput['setSidebarOpen']>(),
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined,
      tuiAgent: 'claude'
    } satisfies FullCreationExecutionInput
    mocks.planAgentSessionLaunch.mockReturnValueOnce(structuredPlan)
    mocks.registerWorkspaceSurfaceProducer.mockReturnValueOnce(mocks.surfaceProducer)
    mocks.queueStandaloneSetupTab.mockImplementationOnce(() => {
      throw new Error('setup queue failed')
    })
    const hook = renderHook(() => useFullCreationExecution(state))

    await expect(
      hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    ).rejects.toThrow('setup queue failed')

    expect(mocks.registerWorkspaceSurfaceProducer).toHaveBeenCalledWith({
      workspaceKey: 'repo-1::/repo/worktree',
      executionHostId: 'local'
    })
    expect(mocks.surfaceProducer.failed).toHaveBeenCalledWith(expect.any(Error))
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.settleFullCreationStructuredLaunch).not.toHaveBeenCalled()
  })
})
