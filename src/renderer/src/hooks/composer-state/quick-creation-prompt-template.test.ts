// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { PreparedQuickSubmit } from './composer-submit-model'
import { useQuickCreationExecution } from './quick-creation-execution'

const originalState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState)
})

it.each(['terminal-tui', 'structured-native-chat'] as const)(
  'uses the workspace target host project template for %s drafts',
  async (route) => {
    const settings = {
      ...getDefaultSettings('/test'),
      linkedWorkItemPromptTemplate: '/global {{url}}'
    }
    const repos = [{ id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 1 }]
    const projection = projectHostSetupProjectionFromRepos(repos)
    useAppStore.setState({
      settings,
      repos,
      projects: projection.projects.map((project) => ({
        ...project,
        linkedWorkItemPromptTemplate: '{{url}} /jira-engineer'
      })),
      projectHostSetups: projection.setups.map((setup) => ({
        ...setup,
        id: 'remote-setup',
        hostId: 'ssh:execution-b'
      }))
    })
    const prepared: PreparedQuickSubmit = {
      submitLinkedWorkItem: {
        type: 'issue',
        provider: 'jira',
        number: 0,
        url: 'https://example.atlassian.net/browse/APP-123',
        title: 'Fix bug'
      },
      agent: 'opencode',
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: { workspaceName: 'fix', displayName: undefined },
      workspaceName: 'fix',
      nameWasGenerated: false,
      smartSubmitBaseBranch: undefined,
      submitCompareBaseRef: undefined,
      submitPushTarget: undefined,
      submitBranchNameOverride: undefined,
      effectiveSetupDecision: 'skip',
      hookPreparation: undefined,
      linkedLinearIssue: undefined,
      linkedLinearIssueWorkspaceId: undefined,
      linkedLinearIssueOrganizationUrlKey: undefined,
      effectiveBranchNameOverride: undefined,
      submitBaseBranch: undefined,
      createDisplayName: undefined,
      pendingFirstAgentMessageRename: false,
      trimmedNote: 'Read first'
    }
    const { result } = renderHook(() =>
      useQuickCreationExecution({
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
        persistSetupAgentStartupPolicy: async () => true,
        prepareQuickSubmit: async () => prepared,
        resetForNextCreate: vi.fn(),
        resolvedInitialWorkspaceStatus: undefined,
        selectedEphemeralVmRecipeId: null,
        selectedRepoAgentLaunchFact: { kind: 'known', platform: 'darwin', hostKind: 'local' },
        selectedRepoExecutionHostId: 'local',
        selectedRepoIsGit: true,
        selectedRepoIsRemote: false,
        selectedRepoTarget: { kind: 'local' },
        selectedRepoStartupShell: 'posix',
        selectedWorkspaceTarget: { status: 'unavailable', reason: 'no-eligible-repo' },
        settings,
        sparseEnabled: false,
        taskSourceContext: null,
        telemetrySource: undefined
      })
    )
    const start = vi.fn<(request: WorktreeCreationRequest) => void>()
    await act(async () => {
      await result.current.executeQuickCreation(
        { kind: 'none' },
        'opencode',
        'fix',
        {
          kind: 'workspace-run',
          projectId: 'repo:repo-1',
          hostId: 'ssh:execution-b',
          projectHostSetupId: 'remote-setup',
          repoId: 'repo-1',
          path: '/repo'
        },
        'repo-1',
        { launchChoice: { agent: 'opencode', route } },
        { start, isHandedOff: () => true, fail: () => false, dispose: vi.fn() }
      )
    })
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        launchDraftPrompt:
          'Read first\n\nhttps://example.atlassian.net/browse/APP-123 /jira-engineer',
        promptDelivery: 'draft',
        quickPrompt: ''
      })
    )
  }
)
