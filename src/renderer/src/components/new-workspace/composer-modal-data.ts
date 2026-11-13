import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { DirectWorkItemSetupRequest } from '@/lib/workspace/creation/work-item/direct-work-item-setup'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-items/work-item-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { WorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import type { ComposerCardProps } from '@/hooks/useComposerState'

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
  backlogTaskPrompt?: string
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

/** Quick create ignores legacy prompt-prefill payloads; only Backlog seeds its task prompt. */
export function getQuickCreateInitialPrompt(data: ComposerModalData): string {
  return data.taskSourceContext?.provider === 'backlog' ? (data.backlogTaskPrompt ?? '') : ''
}

/** Restores the submitted target, edited draft and picker when a failed launch is reopened. */
export function buildComposerRecoveryData(
  data: ComposerModalData,
  card: ComposerCardProps,
  recovery: NonNullable<ComposerModalData['recovery']>
): ComposerModalData {
  return {
    ...data,
    prefilledName: card.name,
    initialRepoId: card.repoId,
    initialBaseBranch: card.baseBranch,
    initialWorkspaceTarget:
      card.selectedProjectId && card.selectedRepoExecutionHostId
        ? {
            projectId: card.selectedProjectId,
            hostId: card.selectedRepoExecutionHostId,
            projectHostSetupId: card.selectedProjectHostSetupId ?? null
          }
        : data.initialWorkspaceTarget,
    linkedWorkItem: card.linkedWorkItem,
    // Non-Backlog sources ignore this field when the composer is reopened.
    backlogTaskPrompt: card.agentPrompt,
    recovery
  }
}
