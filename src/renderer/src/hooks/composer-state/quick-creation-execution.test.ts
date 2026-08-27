// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useQuickCreationExecution,
  type QuickCreationExecutionInput
} from './quick-creation-execution'
import type { PreparedQuickSubmit } from './composer-submit-model'

const mocks = vi.hoisted(() => ({
  syncKanbanTaskAfterWorkspaceStart: vi.fn(),
  runBackgroundWorktreeCreation: vi.fn(() => 'creation-1'),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' }))
}))

vi.mock('@/lib/kanban-workspace-start-sync', () => ({
  syncKanbanTaskAfterWorkspaceStart: mocks.syncKanbanTaskAfterWorkspaceStart
}))
vi.mock('@/lib/worktree-creation-flow', () => ({
  runBackgroundWorktreeCreation: mocks.runBackgroundWorktreeCreation
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: mocks.getActiveRuntimeTarget
}))

function makeKanbanPrepared(): PreparedQuickSubmit {
  return {
    submitLinkedWorkItem: {
      type: 'issue',
      provider: 'kanban',
      number: 0,
      title: 'K-1 Fix login',
      url: 'https://kanban.fpimi.ru/?task=K-1',
      kanbanIdentifier: 'K-1'
    },
    agent: null,
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
    smartSubmitBaseBranch: 'main',
    submitCompareBaseRef: undefined,
    submitPushTarget: undefined,
    submitBranchNameOverride: undefined,
    effectiveSetupDecision: 'skip',
    issueCommand: undefined,
    linkedLinearIssue: undefined,
    linkedLinearIssueWorkspaceId: undefined,
    linkedLinearIssueOrganizationUrlKey: undefined,
    effectiveBranchNameOverride: undefined,
    submitBaseBranch: 'main',
    createDisplayName: 'Widgets fix',
    pendingFirstAgentMessageRename: false,
    trimmedNote: ''
  } satisfies PreparedQuickSubmit
}

function makeState(
  overrides: Partial<QuickCreationExecutionInput>
): QuickCreationExecutionInput {
  return {
    clearNewWorkspaceDraft: vi.fn(),
    createMultiple: false,
    effectivePresetId: null,
    ephemeralVmRecipes: [],
    ephemeralVmsEnabled: false,
    isSubmissionCancelled: () => false,
    linkedGitLabIssue: null,
    linkedGitLabMR: null,
    normalizedSparseDirectories: [],
    onCreated: vi.fn(),
    persistDraft: false,
    persistSetupAgentStartupPolicy: vi.fn().mockResolvedValue(true),
    prepareQuickSubmit: vi.fn().mockResolvedValue(makeKanbanPrepared()),
    resetForNextCreate: vi.fn(),
    resolvedInitialWorkspaceStatus: undefined,
    selectedEphemeralVmRecipeId: null,
    selectedRepoAgentLaunchPlatform: 'local',
    selectedRepoExecutionHostId: null,
    selectedRepoIsGit: true,
    selectedRepoIsRemote: false,
    selectedRepoSettings: {},
    selectedRepoStartupShell: 'sh',
    selectedWorkspaceTarget: { status: 'ready' } as never,
    settings: {},
    sparseEnabled: false,
    taskSourceContext: null,
    telemetrySource: undefined,
    ...overrides
  } as unknown as QuickCreationExecutionInput
}

beforeEach(() => {
  mocks.syncKanbanTaskAfterWorkspaceStart.mockReset()
  mocks.runBackgroundWorktreeCreation.mockReset().mockReturnValue('creation-1')
})

describe('useQuickCreationExecution kanban sync', () => {
  it('syncs the Kanban card after background creation is kicked off', async () => {
    const onCreated = vi.fn()
    const state = makeState({ onCreated })
    const hook = renderHook(() => useQuickCreationExecution(state))

    let execution!: Promise<void>
    act(() => {
      execution = hook.result.current.executeQuickCreation(
        { kind: 'none' },
        null,
        'workspace',
        null,
        'repo-1',
        { id: 'repo-1' } as never
      )
    })
    await act(async () => execution)

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledTimes(1)
    expect(mocks.syncKanbanTaskAfterWorkspaceStart).toHaveBeenCalledWith({
      linkedWorkItem: expect.objectContaining({ provider: 'kanban', kanbanIdentifier: 'K-1' }),
      projectName: 'Widgets fix',
      branch: 'workspace'
    })
    expect(onCreated).toHaveBeenCalled()
  })

  it('does not sync the Kanban card when quick submit preparation is abandoned', async () => {
    const state = makeState({
      prepareQuickSubmit: vi.fn().mockResolvedValue(null)
    })
    const hook = renderHook(() => useQuickCreationExecution(state))

    let execution!: Promise<void>
    act(() => {
      execution = hook.result.current.executeQuickCreation(
        { kind: 'none' },
        null,
        'workspace',
        null,
        'repo-1',
        { id: 'repo-1' } as never
      )
    })
    await act(async () => execution)

    expect(mocks.runBackgroundWorktreeCreation).not.toHaveBeenCalled()
    expect(mocks.syncKanbanTaskAfterWorkspaceStart).not.toHaveBeenCalled()
  })
})