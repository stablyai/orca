// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import type { PreparedQuickSubmit } from './composer-submit-model'
import { useQuickCreationExecution } from './quick-creation-execution'
import type { QuickCreationExecutionInput } from './quick-creation-execution-input'
import { resolveQuickWorkItemStartRoute } from './quick-work-item-start-route'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'

const mocks = vi.hoisted(() => ({
  runBackgroundWorktreeCreation: vi.fn(),
  appState: {
    activeRepoId: null,
    activeWorktreeId: null,
    projects: [],
    repos: [] as Repo[],
    settings: null,
    worktreesByRepo: {}
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.appState }
}))

vi.mock('@/lib/worktree-creation-flow', () => ({
  runBackgroundWorktreeCreation: mocks.runBackgroundWorktreeCreation
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  connectionId: null
}

const linkedIssue = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 58,
  title: 'Canary issue',
  url: 'https://github.com/salvadorgu7/orca/issues/58',
  repoId: repo.id
}

function preparedQuickSubmit(
  linkedWorkItem: typeof linkedIssue | null = linkedIssue
): PreparedQuickSubmit {
  return {
    submitLinkedWorkItem: linkedWorkItem,
    agent: 'codex',
    submitLinkedIssueNumber: linkedWorkItem?.number ?? null,
    submitLinkedPR: null,
    submitTitleName: null,
    nameIsAutoManaged: false,
    smartGitHubCreateNames: { workspaceName: 'issue-58', displayName: undefined },
    workspaceName: 'issue-58',
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
    submitBaseBranch: undefined,
    createDisplayName: 'Canary issue',
    pendingFirstAgentMessageRename: false,
    trimmedNote: ''
  }
}

function executionInput(
  settings: GlobalSettings,
  prepared: PreparedQuickSubmit
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
    parentWorktreeId: null,
    persistDraft: false,
    persistSetupAgentStartupPolicy: vi.fn().mockResolvedValue(true),
    prepareQuickSubmit: vi.fn().mockResolvedValue(prepared),
    resetForNextCreate: vi.fn(),
    resolvedInitialWorkspaceStatus: undefined,
    selectedEphemeralVmRecipeId: null,
    selectedRepoAgentLaunchPlatform: 'linux',
    selectedRepoExecutionHostId: 'local',
    selectedRepoIsGit: true,
    selectedRepoIsRemote: false,
    selectedRepoSettings: null,
    selectedRepoStartupShell: 'posix',
    selectedWorkspaceTarget: { status: 'unavailable', reason: 'project-not-found' },
    settings,
    sparseEnabled: false,
    taskSourceContext: null,
    telemetrySource: 'sidebar'
  }
}

function settingsWithDelivery(delivery?: 'draft' | 'submit-after-ready'): GlobalSettings {
  return {
    workItemStartPromptDelivery: delivery,
    experimentalNativeChat: false,
    experimentalStructuredNativeChat: false,
    openAgentTabsInChatByDefault: false
  } as GlobalSettings
}

async function execute(input: QuickCreationExecutionInput): Promise<void> {
  const hook = renderHook(() => useQuickCreationExecution(input))
  await act(() =>
    hook.result.current.executeQuickCreation(
      { kind: 'none' },
      'codex',
      'issue-58',
      null,
      repo.id,
      repo
    )
  )
}

describe('TaskPage composer work-item start delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appState.repos = []
    Reflect.deleteProperty(window, 'api')
    resetRendererAppPlatformCacheForTests()
    setLocalRuntimeCapabilitiesForTests([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
    resetRendererAppPlatformCacheForTests()
  })

  it('routes submit-after-ready through one structured request with no draft or terminal startup', async () => {
    await execute(executionInput(settingsWithDelivery('submit-after-ready'), preparedQuickSubmit()))

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledOnce()
    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        agentLaunchRoute: 'structured-native-chat',
        workItemStartPromptDelivery: 'submit-after-ready',
        quickPrompt: linkedIssue.url,
        linkedIssue: 58
      })
    )
    const request = mocks.runBackgroundWorktreeCreation.mock.calls[0]?.[0]
    expect(request).not.toHaveProperty('startup')
    expect(request).not.toHaveProperty('launchDraftPrompt')
  })

  it('preserves explicit draft delivery for linked items', async () => {
    await execute(executionInput(settingsWithDelivery('draft'), preparedQuickSubmit()))

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentLaunchRoute: 'terminal-tui',
        workItemStartPromptDelivery: 'draft',
        quickPrompt: '',
        launchDraftPrompt: linkedIssue.url
      })
    )
  })

  it('keeps draft as the compatibility default for linked items', async () => {
    await execute(executionInput(settingsWithDelivery(), preparedQuickSubmit()))

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentLaunchRoute: 'terminal-tui',
        workItemStartPromptDelivery: 'draft',
        launchDraftPrompt: linkedIssue.url
      })
    )
  })

  it('does not apply the work-item setting to an ordinary composer create', async () => {
    await execute(
      executionInput(settingsWithDelivery('submit-after-ready'), preparedQuickSubmit(null))
    )

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({ agentLaunchRoute: 'terminal-tui' })
    )
    expect(mocks.runBackgroundWorktreeCreation.mock.calls[0]?.[0]).not.toHaveProperty(
      'workItemStartPromptDelivery'
    )
  })

  it('does not change an ordinary composer draft route', () => {
    const result = resolveQuickWorkItemStartRoute({
      agent: 'codex',
      hasLinkedWorkItem: false,
      settings: settingsWithDelivery('submit-after-ready'),
      executionHostId: 'local',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      workspaceKind: 'git-worktree',
      hasDraftPrompt: true,
      launchText: 'ordinary composer draft',
      nativeChatTranscriptIsLocalReadable: true,
      requiresTuiLaunchCustomization: false
    })

    expect(result).toEqual({ ok: true, route: 'terminal-tui' })
  })

  it('fails before workspace creation when strict structured support is unavailable', async () => {
    const input = executionInput(settingsWithDelivery('submit-after-ready'), preparedQuickSubmit())
    input.selectedRepoExecutionHostId = 'ssh:remote'
    input.selectedRepoIsRemote = true

    await expect(execute(input)).rejects.toThrow('No workspace, terminal, or prompt was started.')
    expect(mocks.runBackgroundWorktreeCreation).not.toHaveBeenCalled()
  })

  it('fails before creation when a Windows renderer owns a WSL checkout', async () => {
    mocks.appState.repos = [{ ...repo, path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' }]
    Object.assign(window, {
      api: { platform: { get: () => ({ platform: 'win32' as const }) } }
    })
    resetRendererAppPlatformCacheForTests()

    await expect(
      execute(executionInput(settingsWithDelivery('submit-after-ready'), preparedQuickSubmit()))
    ).rejects.toThrow('No workspace, terminal, or prompt was started.')
    expect(mocks.runBackgroundWorktreeCreation).not.toHaveBeenCalled()
  })
})
