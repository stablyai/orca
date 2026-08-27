// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useFullCreationExecution,
  type FullCreationExecutionInput
} from './full-creation-execution'
import type { PreparedFullSubmit } from './composer-submit-model'

const syncMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/kanban-workspace-start-sync', () => ({
  syncKanbanTaskAfterWorkspaceStart: syncMock
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function makeKanbanPrepared(): PreparedFullSubmit {
  return {
    submitLinkedWorkItem: {
      type: 'issue',
      provider: 'kanban',
      number: 0,
      title: 'K-1 Fix login',
      url: 'https://kanban.fpimi.ru/?task=K-1',
      kanbanIdentifier: 'K-1'
    },
    submitLinkedIssueNumber: null,
    submitLinkedPR: null,
    submitTitleName: null,
    nameIsAutoManaged: true,
    smartGitHubCreateNames: {
      workspaceName: 'workspace',
      displayName: undefined
    },
    workspaceName: 'workspace',
    nameWasGenerated: true,
    submitBaseBranch: 'main',
    submitCompareBaseRef: undefined,
    submitPushTarget: undefined,
    submitBranchNameOverride: undefined,
    submitLinkedWorkItemProvider: 'kanban',
    submitStartupPrompt: '',
    submitShouldRunIssueAutomation: false,
    effectiveSetupDecision: 'skip',
    issueCommandTrustDecision: 'skip',
    confirmedIssueCommandTemplate: '',
    linkedLinearIssue: undefined,
    linkedLinearIssueWorkspaceId: undefined,
    linkedLinearIssueOrganizationUrlKey: undefined,
    effectiveBranchNameOverride: undefined,
    createDisplayName: 'Widgets fix',
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
}

function makeState(overrides: Partial<FullCreationExecutionInput>): FullCreationExecutionInput {
  return {
    applyWorktreeMeta: vi
      .fn<FullCreationExecutionInput['applyWorktreeMeta']>()
      .mockResolvedValue(),
    clearNewWorkspaceDraft: vi.fn<FullCreationExecutionInput['clearNewWorkspaceDraft']>(),
    createWorktree: vi.fn<FullCreationExecutionInput['createWorktree']>(),
    effectivePresetId: null,
    isSubmissionCancelled: () => false,
    linkedGitLabIssue: null,
    linkedGitLabMR: null,
    normalizedSparseDirectories: [],
    note: '',
    onCreated: vi.fn<NonNullable<FullCreationExecutionInput['onCreated']>>(),
    persistDraft: false,
    persistSetupAgentStartupPolicy: vi.fn().mockResolvedValue(true),
    prepareFullSubmit: vi
      .fn<FullCreationExecutionInput['prepareFullSubmit']>()
      .mockResolvedValue(makeKanbanPrepared()),
    resolvedInitialWorkspaceStatus: undefined,
    selectedRepoIsGit: true,
    setSidebarOpen: vi.fn<FullCreationExecutionInput['setSidebarOpen']>(),
    sparseEnabled: false,
    taskSourceContext: null,
    telemetrySource: undefined,
    tuiAgent: 'claude',
    ...overrides
  }
}

describe('useFullCreationExecution cancellation', () => {
  it('does not create after dismissal while the late startup-policy preflight is pending', async () => {
    const startupPolicy = deferred<boolean>()
    let cancelled = false
    const createWorktree = vi.fn<FullCreationExecutionInput['createWorktree']>()
    const state = makeState({
      createWorktree,
      isSubmissionCancelled: () => cancelled,
      persistSetupAgentStartupPolicy: vi.fn(() => startupPolicy.promise)
    })
    const hook = renderHook(() => useFullCreationExecution(state))

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    })
    await act(() => Promise.resolve())
    expect(state.persistSetupAgentStartupPolicy).toHaveBeenCalledTimes(1)

    cancelled = true
    startupPolicy.resolve(true)
    await act(async () => creation)

    expect(createWorktree).not.toHaveBeenCalled()
  })
})

describe('useFullCreationExecution kanban sync', () => {
  it('syncs the Kanban card after successful creation with the actual display name and branch', async () => {
    syncMock.mockReset()
    const onCreated = vi.fn()
    const state = makeState({
      createWorktree: vi.fn().mockResolvedValue({
        worktree: { id: 'wt-9', branch: 'feature-x' },
        setup: undefined,
        defaultTabs: undefined,
        startupTerminal: { spawned: false }
      }),
      onCreated
    })
    const hook = renderHook(() => useFullCreationExecution(state))

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    })
    await act(async () => creation)

    expect(syncMock).toHaveBeenCalledWith({
      linkedWorkItem: expect.objectContaining({ provider: 'kanban', kanbanIdentifier: 'K-1' }),
      projectName: 'Widgets fix',
      branch: 'feature-x'
    })
    expect(onCreated).toHaveBeenCalled()
  })

  it('does not sync the Kanban card when workspace creation fails', async () => {
    syncMock.mockReset()
    const onCreated = vi.fn()
    const state = makeState({
      createWorktree: vi.fn().mockRejectedValue(new Error('creation failed')),
      onCreated
    })
    const hook = renderHook(() => useFullCreationExecution(state))

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    })
    await act(async () => {
      await expect(creation).rejects.toThrow('creation failed')
    })

    expect(syncMock).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })
})