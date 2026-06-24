import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import type {
  JiraIssue,
  JiraMutationResult,
  JiraTransition,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import type {
  SyncWorkspaceBoardTaskStatusesArgs,
  WorkspaceBoardTaskStatusSyncDependencies,
  WorkspaceBoardTaskStatusSyncResult
} from './workspace-board-task-status-sync'
import {
  createTaskStatusSyncResult,
  markTaskStatusSyncFailed,
  markTaskStatusSyncSkipped
} from './workspace-board-task-status-sync-result'

function normalizeStateName(name: string): string {
  return name.trim().toLowerCase()
}

function getJiraSiteId(
  settings: RuntimeJiraSettings,
  fallbackSiteId: string | null | undefined
): string | null {
  if (fallbackSiteId?.trim()) {
    return fallbackSiteId.trim()
  }
  if (!settings || !('kind' in settings)) {
    return null
  }
  return settings.providerIdentity?.provider === 'jira'
    ? (settings.providerIdentity.siteId ?? null)
    : null
}

function matchingJiraTransitions(
  transitions: readonly JiraTransition[],
  targetStatus: WorkspaceStatusDefinition
): JiraTransition[] {
  const targetName = normalizeStateName(targetStatus.label)
  return transitions.filter(
    (transition) =>
      normalizeStateName(transition.name) === targetName ||
      normalizeStateName(transition.to.name) === targetName
  )
}

export async function syncJiraWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies,
  settings: RuntimeJiraSettings
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const syncResult = createTaskStatusSyncResult()
  const issueKey = args.worktreesById.get(worktreeId)?.linkedJiraIssue?.trim()
  if (!issueKey) {
    return markTaskStatusSyncSkipped(syncResult, {
      kind: 'linked-issue-missing',
      provider: 'Jira'
    })
  }
  const siteId = getJiraSiteId(settings, args.worktreesById.get(worktreeId)?.linkedJiraIssueSiteId)
  try {
    const issue: JiraIssue | null = await deps.getJiraIssue(settings, issueKey, siteId)
    if (!issue) {
      return markTaskStatusSyncSkipped(syncResult, {
        kind: 'issue-read-failed',
        provider: 'Jira',
        issueIdentifier: issueKey
      })
    }
    if (normalizeStateName(issue.status.name) === normalizeStateName(args.targetStatus.label)) {
      return markTaskStatusSyncSkipped(syncResult)
    }
    const transitions = await deps.listJiraTransitions(settings, issueKey, siteId)
    const matches = matchingJiraTransitions(transitions, args.targetStatus)
    if (matches.length === 0) {
      return markTaskStatusSyncSkipped(syncResult, {
        kind: 'missing-provider-status-mapping',
        provider: 'Jira',
        statusLabel: args.targetStatus.label
      })
    }
    if (matches.length > 1) {
      return markTaskStatusSyncSkipped(syncResult, {
        kind: 'ambiguous-provider-status-mapping',
        provider: 'Jira',
        statusLabel: args.targetStatus.label
      })
    }
    // Why: if board status changed while Jira calls were in flight, skip this
    // transition so an older move cannot overwrite a newer local status.
    if (args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id) {
      return markTaskStatusSyncSkipped(syncResult)
    }
    const updateResult: JiraMutationResult = await deps.updateJiraIssue(
      settings,
      issueKey,
      { transitionId: matches[0].id },
      siteId
    )
    if (updateResult.ok === false) {
      return markTaskStatusSyncFailed(syncResult, {
        kind: 'update-failed',
        provider: 'Jira',
        issueIdentifier: issueKey,
        detail: updateResult.error
      })
    }
    syncResult.updated += 1
    return syncResult
  } catch (error) {
    return markTaskStatusSyncFailed(syncResult, {
      kind: 'provider-error',
      provider: 'Jira',
      issueIdentifier: issueKey,
      detail: error instanceof Error ? error.message : undefined
    })
  }
}
