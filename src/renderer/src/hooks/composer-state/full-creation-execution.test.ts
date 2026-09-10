// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const routeMocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(() => ({ primaryTabId: 'tab-1' })),
  settleFullCreationStructuredLaunch: vi.fn(),
  finalizeFullCreation: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealWorktree: routeMocks.activateAndRevealWorktree }
})
vi.mock('./full-creation-structured-launch', () => ({
  settleFullCreationStructuredLaunch: routeMocks.settleFullCreationStructuredLaunch
}))
vi.mock('./full-creation-finalization', () => ({
  finalizeFullCreation: routeMocks.finalizeFullCreation
}))

import {
  useFullCreationExecution,
  type FullCreationExecutionInput
} from './full-creation-execution'
import type { PreparedFullSubmit } from './composer-submit-model'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

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
      selectedRepoIsRemote: false,
      setSidebarOpen: vi.fn<FullCreationExecutionInput['setSidebarOpen']>(),
      settings: null,
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

describe('useFullCreationExecution launch route before hydration', () => {
  const structuredSettings = {
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: true,
    experimentalStructuredNativeChat: true
  } as GlobalSettings

  function makePrepared(): PreparedFullSubmit {
    return {
      submitLinkedWorkItem: null,
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: { workspaceName: 'workspace', displayName: undefined },
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
  }

  function makeState(): FullCreationExecutionInput {
    return {
      applyWorktreeMeta: vi
        .fn<FullCreationExecutionInput['applyWorktreeMeta']>()
        .mockResolvedValue(),
      clearNewWorkspaceDraft: vi.fn<FullCreationExecutionInput['clearNewWorkspaceDraft']>(),
      createWorktree: vi
        .fn<FullCreationExecutionInput['createWorktree']>()
        .mockResolvedValue({ worktree: { id: 'wt-1' } } as Awaited<
          ReturnType<FullCreationExecutionInput['createWorktree']>
        >),
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
        .mockResolvedValue(makePrepared()),
      resolvedInitialWorkspaceStatus: undefined,
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      selectedRepoIsRemote: false,
      setSidebarOpen: vi.fn<FullCreationExecutionInput['setSidebarOpen']>(),
      settings: structuredSettings,
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined,
      tuiAgent: 'claude'
    } satisfies FullCreationExecutionInput
  }

  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
    Reflect.deleteProperty(window, 'api')
    vi.clearAllMocks()
  })

  it('probes the local runtime instead of degrading to legacy when capabilities are unknown', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi
      .fn()
      .mockResolvedValue({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    Object.assign(window, { api: { runtime: { getStatus } } })
    routeMocks.settleFullCreationStructuredLaunch.mockImplementation(async (args) => ({
      structuredLaunchAccepted: args.structuredLaunch,
      visibilityUnknown: false,
      activation: args.initialActivation
    }))

    const hook = renderHook(() => useFullCreationExecution(makeState()))
    await act(async () => hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1'))

    expect(getStatus).toHaveBeenCalled()
    expect(routeMocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ providesInitialSurface: true })
    )
    expect(routeMocks.settleFullCreationStructuredLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ structuredLaunch: true })
    )
  })

  it('does not create when the composer is dismissed while the probe is still pending', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const status = deferred<{ capabilities: readonly string[] }>()
    const getStatus = vi.fn(() => status.promise)
    Object.assign(window, { api: { runtime: { getStatus } } })
    let cancelled = false
    const state = { ...makeState(), isSubmissionCancelled: () => cancelled }
    const hook = renderHook(() => useFullCreationExecution(state))

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getStatus).toHaveBeenCalledTimes(1)

    cancelled = true
    status.resolve({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    await act(async () => creation)

    expect(state.createWorktree).not.toHaveBeenCalled()
  })
})
