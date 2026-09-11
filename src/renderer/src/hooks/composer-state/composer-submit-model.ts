import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceIntentName } from '../../../../shared/workspace-name'
import type { AgentStartupPlan } from '../../../../shared/tui-agent-startup'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

type SmartCreateNames = {
  workspaceName: string
  displayName: string | undefined
}

export type FullSubmitSource = {
  submitLinkedWorkItem: LinkedWorkItemSummary | null
  submitLinkedIssueNumber: number | null
  submitLinkedPR: number | null
  submitTitleName: WorkspaceIntentName | null
  nameIsAutoManaged: boolean
  smartGitHubCreateNames: SmartCreateNames
  workspaceName: string
  nameWasGenerated: boolean
  submitBaseBranch: string | undefined
  submitCompareBaseRef: string | undefined
  submitPushTarget: GitPushTarget | undefined
  submitBranchNameOverride: string | undefined
  submitLinkedWorkItemProvider: LinkedWorkItemSummary['provider'] | null
  submitStartupPrompt: string
  submitShouldRunIssueAutomation: boolean
}

export type PreparedFullSubmit = FullSubmitSource & {
  effectiveSetupDecision: SetupDecision
  issueCommandTrustDecision: 'run' | 'skip'
  confirmedIssueCommandTemplate: string
  linkedLinearIssue: string | undefined
  linkedLinearIssueWorkspaceId: string | undefined
  linkedLinearIssueOrganizationUrlKey: string | undefined
  effectiveBranchNameOverride: string | undefined
  createDisplayName: string | undefined
  pendingFirstAgentMessageRename: boolean
  startupPlan: AgentStartupPlan | null
  shouldSeedInitialAgentStatus: boolean
  composerTelemetry: AgentStartedTelemetry
  backendStartup: WorktreeCreationRequest['startup']
}

export type QuickSubmitSource = {
  submitLinkedWorkItem: LinkedWorkItemSummary | null
  agent: TuiAgent | null
  submitLinkedIssueNumber: number | null
  submitLinkedPR: number | null
  submitTitleName: WorkspaceIntentName | null
  nameIsAutoManaged: boolean
  smartGitHubCreateNames: SmartCreateNames
  workspaceName: string
  nameWasGenerated: boolean
  smartSubmitBaseBranch: string | undefined
  submitCompareBaseRef: string | undefined
  submitPushTarget: GitPushTarget | undefined
  submitBranchNameOverride: string | undefined
}

export type PreparedQuickSubmit = QuickSubmitSource & {
  effectiveSetupDecision: SetupDecision
  issueCommand: WorktreeCreationRequest['issueCommand']
  linkedLinearIssue: string | undefined
  linkedLinearIssueWorkspaceId: string | undefined
  linkedLinearIssueOrganizationUrlKey: string | undefined
  effectiveBranchNameOverride: string | undefined
  submitBaseBranch: string | undefined
  createDisplayName: string | undefined
  pendingFirstAgentMessageRename: boolean
  trimmedNote: string
}

export type ComposerSubmitModel = {
  executeFullCreation: (
    resolution: PendingSmartGitHubSubmitResolution,
    repoId: string
  ) => Promise<void>
  executeQuickCreation: (
    resolution: PendingSmartGitHubSubmitResolution,
    requestedAgent: TuiAgent | null,
    workspaceNameSeed: string,
    workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'],
    repoId: string,
    selectedRepo: Repo
  ) => Promise<void>
  prepareFullSubmit: (
    resolution: PendingSmartGitHubSubmitResolution
  ) => Promise<PreparedFullSubmit | null>
  prepareFullSubmitSource: (
    resolution: PendingSmartGitHubSubmitResolution
  ) => FullSubmitSource | null
  prepareQuickSubmit: (
    resolution: PendingSmartGitHubSubmitResolution,
    requestedAgent: TuiAgent | null,
    workspaceNameSeed: string
  ) => Promise<PreparedQuickSubmit | null>
  prepareQuickSubmitSource: (
    resolution: PendingSmartGitHubSubmitResolution,
    requestedAgent: TuiAgent | null,
    workspaceNameSeed: string
  ) => QuickSubmitSource | null
  resetForNextCreate: () => void
  submit: () => Promise<void>
  submitQuick: (agent: TuiAgent | null) => Promise<void>
  submitFolderTarget: (requestedAgent: TuiAgent | null) => Promise<void>
}
