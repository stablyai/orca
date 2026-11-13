import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { DirectWorkItemSetupRequest } from '@/lib/workspace/creation/work-item/direct-work-item-setup'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { WorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'

export type ComposerModalData = {
  recovery?: {
    note: string
    agent: TuiAgent | null
    surface?: AgentLaunchSurface
    draft?: AgentPickerDraft
    entry?: AgentPickerEntry
    contextKey?: string
  }
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
  initialParentWorktreeId?: string
  initialWorkspaceStatus?: WorkspaceStatus
  enableIssueAutomation?: boolean
  /** Creation-surface telemetry; each opener supplies it, otherwise use unknown. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  contextualTourSource?: string
  setupGuideTourRequestId?: string
}
