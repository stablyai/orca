import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LinkedPluginTask } from '../../../../shared/plugins/plugin-task-link'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { WorkspaceIntentName } from '../../../../shared/workspace-name'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'

type SmartCreateNames = {
  workspaceName: string
  displayName: string | undefined
}

export type QuickSubmitOptions = {
  /** Draft typed into the agent after launch (not sent for folder-group targets). */
  agentDraft?: string
  /** Session options (e.g. model, effort) layered over the agent's defaults for this launch. */
  sessionOptions?: Record<string, string>
  /** Plugin task the new workspace links back to. */
  linkedPluginTask?: LinkedPluginTask
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
  hookPreparation: WorktreeCreationRequest['hookPreparation']
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
  executeQuickCreation: (
    resolution: PendingSmartGitHubSubmitResolution,
    requestedAgent: TuiAgent | null,
    workspaceNameSeed: string,
    workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'],
    repoId: string,
    options?: QuickSubmitOptions
  ) => Promise<void>
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
  submitQuick: (agent: TuiAgent | null, options?: QuickSubmitOptions) => Promise<void>
  submitFolderTarget: (requestedAgent: TuiAgent | null) => Promise<void>
}
