// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import type { PreparedQuickSubmit } from './composer-submit-model'

const mocks = vi.hoisted(() => ({
  runBackgroundWorktreeCreation: vi.fn(),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' as const }))
}))

vi.mock('@/lib/worktree-creation-flow', () => ({
  runBackgroundWorktreeCreation: mocks.runBackgroundWorktreeCreation
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: mocks.getActiveRuntimeTarget
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import {
  useQuickCreationExecution,
  type QuickCreationExecutionInput
} from './quick-creation-execution'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

const structuredSettings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
} as GlobalSettings

function makePrepared(): PreparedQuickSubmit {
  return {
    submitLinkedWorkItem: null,
    agent: 'claude',
    submitLinkedIssueNumber: null,
    submitLinkedPR: null,
    submitTitleName: null,
    nameIsAutoManaged: false,
    smartGitHubCreateNames: { workspaceName: 'workspace', displayName: undefined },
    workspaceName: 'workspace',
    nameWasGenerated: false,
    smartSubmitBaseBranch: undefined,
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
    createDisplayName: undefined,
    pendingFirstAgentMessageRename: false,
    trimmedNote: ''
  }
}

function makeInput(): QuickCreationExecutionInput {
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
    parentWorktreeId: null,
    persistDraft: false,
    persistSetupAgentStartupPolicy: vi.fn(async () => true),
    prepareQuickSubmit: vi.fn(async () => makePrepared()),
    resetForNextCreate: vi.fn(),
    resolvedInitialWorkspaceStatus: undefined,
    selectedEphemeralVmRecipeId: null,
    selectedRepoAgentLaunchPlatform: 'darwin',
    selectedRepoExecutionHostId: 'local',
    selectedRepoIsGit: true,
    selectedRepoIsRemote: false,
    selectedRepoSettings: null,
    selectedRepoStartupShell: undefined,
    selectedWorkspaceTarget: { status: 'unavailable', reason: 'no-eligible-repo' },
    settings: structuredSettings,
    sparseEnabled: false,
    taskSourceContext: null,
    telemetrySource: undefined
  }
}

const repo = { id: 'repo-1', path: '/repo', connectionId: null } as Repo

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useQuickCreationExecution launch route before hydration', () => {
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

    const hook = renderHook(() => useQuickCreationExecution(makeInput()))
    await act(async () =>
      hook.result.current.executeQuickCreation(
        { kind: 'none' },
        'claude',
        'workspace',
        null,
        'repo-1',
        repo
      )
    )

    expect(getStatus).toHaveBeenCalled()
    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledTimes(1)
    expect(mocks.runBackgroundWorktreeCreation.mock.calls[0][0]).toMatchObject({
      agentLaunchRoute: 'structured-native-chat'
    })
  })

  it('keeps the legacy route when the probed host does not support structured sessions', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi.fn().mockResolvedValue({ capabilities: [] })
    Object.assign(window, { api: { runtime: { getStatus } } })

    const hook = renderHook(() => useQuickCreationExecution(makeInput()))
    await act(async () =>
      hook.result.current.executeQuickCreation(
        { kind: 'none' },
        'claude',
        'workspace',
        null,
        'repo-1',
        repo
      )
    )

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledTimes(1)
    expect(mocks.runBackgroundWorktreeCreation.mock.calls[0][0]).toMatchObject({
      agentLaunchRoute: 'legacy-native-chat'
    })
  })

  it('does not create when the composer is dismissed while the probe is still pending', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const status = deferred<{ capabilities: readonly string[] }>()
    const getStatus = vi.fn(() => status.promise)
    Object.assign(window, { api: { runtime: { getStatus } } })
    let cancelled = false
    const hook = renderHook(() =>
      useQuickCreationExecution({ ...makeInput(), isSubmissionCancelled: () => cancelled })
    )

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeQuickCreation(
        { kind: 'none' },
        'claude',
        'workspace',
        null,
        'repo-1',
        repo
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getStatus).toHaveBeenCalledTimes(1)

    cancelled = true
    status.resolve({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    await act(async () => creation)

    expect(mocks.runBackgroundWorktreeCreation).not.toHaveBeenCalled()
  })
})
