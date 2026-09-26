import type { NotificationSettings } from './notification-settings-types'
import type { AgentStatusState } from './agent-status-types'
import type { WorktreeMeta } from './worktree/meta-types'

export type WorkspaceNotificationOrigin = 'cli' | 'automation' | 'other'

export function getWorkspaceNotificationOrigin(
  workspace:
    | Pick<WorktreeMeta, 'cliProvenance' | 'automationProvenance' | 'orcaCreationSource'>
    | undefined
): WorkspaceNotificationOrigin {
  if (workspace?.automationProvenance?.kind === 'created-by-automation') {
    return 'automation'
  }
  return workspace?.cliProvenance?.kind === 'created-by-cli' ||
    workspace?.orcaCreationSource === 'cli'
    ? 'cli'
    : 'other'
}

export function allowsWorkspaceAgentNotification(
  settings: Pick<
    NotificationSettings,
    'cliWorktreeTaskComplete' | 'automationWorktreeTaskComplete'
  >,
  origin: WorkspaceNotificationOrigin | undefined,
  agentState?: AgentStatusState
): boolean {
  // The completion channel also carries prompts that still need the user's attention.
  if (agentState !== undefined && agentState !== 'done') {
    return true
  }
  if (origin === 'automation') {
    return settings.automationWorktreeTaskComplete !== false
  }
  return origin !== 'cli' || settings.cliWorktreeTaskComplete !== false
}
