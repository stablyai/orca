// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useFullCreationExecution,
  type FullCreationExecutionInput
} from './full-creation-execution'
import type { PreparedFullSubmit } from './composer-submit-model'

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
      persistDraft: false,
      persistSetupAgentStartupPolicy,
      prepareFullSubmit: vi
        .fn<FullCreationExecutionInput['prepareFullSubmit']>()
        .mockResolvedValue(prepared),
      resolvedInitialWorkspaceStatus: undefined,
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
})
