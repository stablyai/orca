import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import { toFolderWorkspaceLinkedTask } from '@/components/sidebar/folder-workspace-composer-helpers'

export type QuickCreationRequestInput = {
  repoId: string
  ephemeralVmRecipe: WorktreeCreationRequest['ephemeralVmRecipe']
  indeterminateProgress: boolean
  taskSourceContext: TaskSourceContext | null
  linkedWorkItem: LinkedWorkItemSummary | null
  workspaceRunContext: WorktreeCreationRequest['workspaceRunContext']
  workspaceName: string
  nameWasGenerated: boolean
  displayName: string | undefined
  selectedRepoIsGit: boolean
  baseBranch: string | undefined
  compareBaseRef: string | undefined
  setupDecision: SetupDecision
  sparseDirectories: string[] | null
  sparsePresetId: string | null
  telemetrySource: WorktreeCreationRequest['telemetrySource']
  linkedIssue: number | null
  linkedPR: number | null
  pushTarget: GitPushTarget | undefined
  agent: TuiAgent | null
  linkedLinearIssue: string | undefined
  linkedLinearIssueWorkspaceId: string | undefined
  linkedLinearIssueOrganizationUrlKey: string | undefined
  branchNameOverride: string | undefined
  workspaceStatus: WorktreeCreationRequest['workspaceStatus']
  linkedGitLabMR: number | null
  linkedGitLabIssue: number | null
  includeGitLabLinks: boolean
  startup: WorktreeCreationRequest['startup']
  issueCommand: WorktreeCreationRequest['issueCommand']
  pendingFirstAgentMessageRename: boolean
  note: string
  startupPlan: AgentStartupPlan | null
  quickPrompt: string
  launchDraftPrompt: string | null | undefined
  quickTelemetry: AgentStartedTelemetry | null
  suppressTerminalFocusOnCompletion: boolean
}

export function buildQuickCreationRequest(
  input: QuickCreationRequestInput
): WorktreeCreationRequest {
  return {
    repoId: input.repoId,
    ...(input.ephemeralVmRecipe ? { ephemeralVmRecipe: input.ephemeralVmRecipe } : {}),
    worktreeCreateProgressMode: input.indeterminateProgress ? 'indeterminate' : 'stepped',
    ...(input.taskSourceContext ? { taskSourceContext: input.taskSourceContext } : {}),
    linkedWorkItem: toFolderWorkspaceLinkedTask(input.linkedWorkItem),
    linkedTaskSourceContext: input.taskSourceContext,
    ...(input.workspaceRunContext ? { workspaceRunContext: input.workspaceRunContext } : {}),
    name: input.workspaceName,
    ...(input.nameWasGenerated ? { nameWasGenerated: true } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.selectedRepoIsGit && input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.selectedRepoIsGit && input.compareBaseRef
      ? { compareBaseRef: input.compareBaseRef }
      : {}),
    setupDecision: input.setupDecision,
    ...(input.selectedRepoIsGit && input.sparseDirectories
      ? {
          sparseCheckout: {
            directories: input.sparseDirectories,
            ...(input.sparsePresetId ? { presetId: input.sparsePresetId } : {})
          }
        }
      : {}),
    ...(input.telemetrySource ? { telemetrySource: input.telemetrySource } : {}),
    ...(input.linkedIssue != null ? { linkedIssue: input.linkedIssue } : {}),
    ...(input.linkedPR != null ? { linkedPR: input.linkedPR } : {}),
    ...(input.pushTarget ? { pushTarget: input.pushTarget } : {}),
    agent: input.agent,
    ...(input.linkedLinearIssue ? { linkedLinearIssue: input.linkedLinearIssue } : {}),
    ...(input.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: input.linkedLinearIssueWorkspaceId }
      : {}),
    ...(input.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: input.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(input.branchNameOverride ? { branchNameOverride: input.branchNameOverride } : {}),
    ...(input.workspaceStatus ? { workspaceStatus: input.workspaceStatus } : {}),
    ...(input.includeGitLabLinks && input.linkedGitLabMR != null
      ? { linkedGitLabMR: input.linkedGitLabMR }
      : {}),
    ...(input.includeGitLabLinks && input.linkedGitLabIssue != null
      ? { linkedGitLabIssue: input.linkedGitLabIssue }
      : {}),
    ...(input.startup ? { startup: input.startup } : {}),
    ...(input.issueCommand ? { issueCommand: input.issueCommand } : {}),
    pendingFirstAgentMessageRename: input.pendingFirstAgentMessageRename,
    note: input.note,
    startupPlan: input.startupPlan,
    quickPrompt: input.quickPrompt,
    ...(input.launchDraftPrompt ? { launchDraftPrompt: input.launchDraftPrompt } : {}),
    quickTelemetry: input.quickTelemetry,
    ...(input.suppressTerminalFocusOnCompletion ? { suppressTerminalFocusOnCompletion: true } : {})
  }
}
