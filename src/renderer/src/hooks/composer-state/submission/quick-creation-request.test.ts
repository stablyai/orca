import { describe, expect, it } from 'vitest'
import { buildQuickCreationRequest, type QuickCreationRequestInput } from './quick-creation-request'

function createInput(
  overrides: Partial<QuickCreationRequestInput> = {}
): QuickCreationRequestInput {
  return {
    repoId: 'repo-1',
    ephemeralVmRecipe: undefined,
    indeterminateProgress: false,
    taskSourceContext: null,
    linkedWorkItem: null,
    workspaceRunContext: null,
    workspaceName: 'characterize-request',
    nameWasGenerated: false,
    displayName: undefined,
    selectedRepoIsGit: true,
    baseBranch: undefined,
    compareBaseRef: undefined,
    setupDecision: 'inherit',
    sparseDirectories: null,
    sparsePresetId: null,
    telemetrySource: undefined,
    linkedIssue: null,
    linkedPR: null,
    pushTarget: undefined,
    agent: null,
    linkedLinearIssue: undefined,
    linkedLinearIssueWorkspaceId: undefined,
    linkedLinearIssueOrganizationUrlKey: undefined,
    branchNameOverride: undefined,
    parentWorktreeId: null,
    workspaceStatus: undefined,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    includeGitLabLinks: true,
    startup: undefined,
    issueCommand: undefined,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    launchDraftPrompt: '',
    promptDelivery: 'auto-submit',
    quickTelemetry: null,
    suppressTerminalFocusOnCompletion: false,
    setupOnly: false,
    ...overrides
  }
}

describe('quick composer creation request', () => {
  it('carries the Perforce copy choice for folder projects only', () => {
    const perforceCopy = { stream: { kind: 'child' as const } }
    expect(
      buildQuickCreationRequest(createInput({ selectedRepoIsGit: false, perforceCopy }))
        .perforceCopy
    ).toEqual(perforceCopy)
    expect(
      buildQuickCreationRequest(createInput({ selectedRepoIsGit: true, perforceCopy })).perforceCopy
    ).toBeUndefined()
  })
})
