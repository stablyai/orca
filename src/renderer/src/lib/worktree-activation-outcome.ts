import { toast } from 'sonner'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type { WorktreeStartupPayload } from './worktree-startup-payload'
import type { WorktreeActivationSurfaceSelection } from './worktree-activation-surface-selection'
import { agentLaunchPaneNoticeText } from '@/components/terminal-pane/agent-launch-pane-notice-text'

export type ActivateAndRevealResult = { primaryTabId: string | null }

export type WorkspaceActivationOutcome =
  | { opened: ActivateAndRevealResult }
  | {
      refused:
        | { reason: 'workspace-missing'; failureNotified: false }
        | { reason: 'path-blocked'; failureNotified: true }
    }

export type WorkspaceRevealOptions = WorktreeActivationSurfaceSelection & {
  executionHostId?: ExecutionHostId
  sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
  revealInSidebar?: boolean
  showWorkspaceList?: boolean
  clearSidebarFilters?: boolean
}

export type FolderWorkspaceActivationOptions = Omit<
  WorkspaceRevealOptions,
  'clearSidebarFilters'
> & {
  startup?: WorktreeStartupPayload
  runtimeEnvironmentId?: string | null
}

export function workspaceActivationResult(
  outcome: WorkspaceActivationOutcome
): ActivateAndRevealResult | false {
  return 'opened' in outcome ? outcome.opened : false
}

export function reportAgentWorkspaceActivation(
  outcome: WorkspaceActivationOutcome,
  agent: TuiAgent,
  failureMessage?: string
): boolean {
  if ('opened' in outcome) {
    return true
  }
  if (!outcome.refused.failureNotified) {
    toast.error(
      failureMessage ??
        agentLaunchPaneNoticeText({ kind: 'not-started', code: 'worktree_not_found' }, agent)
    )
  }
  return false
}
