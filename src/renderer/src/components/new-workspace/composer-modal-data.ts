import type { DirectWorkItemSetupRequest } from '@/lib/direct-work-item-setup'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'

export type ComposerModalData = {
  directSetup?: DirectWorkItemSetupRequest
  prefilledName?: string
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  taskSourceContext?: TaskSourceContext | null
  initialWorkspaceTarget?: WorkspaceCreationTargetHint | null
  initialBaseBranch?: string
  initialWorkspaceStatus?: WorkspaceStatus
  enableIssueAutomation?: boolean
  /** Creation-surface telemetry; each opener supplies it, otherwise use unknown. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  contextualTourSource?: string
  setupGuideTourRequestId?: string
}
