import type { GitLabIssueUpdate } from '../../../../shared/gitlab-types'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import type {
  SyncWorkspaceBoardTaskStatusesArgs,
  WorkspaceBoardTaskStatusSyncDependencies,
  WorkspaceBoardTaskStatusSyncResult
} from './workspace-board-task-status-sync'
import { syncJiraWorktreeStatus } from './workspace-board-jira-task-status-sync'
import {
  createTaskStatusSyncResult,
  markTaskStatusSyncFailed,
  markTaskStatusSyncSkipped
} from './workspace-board-task-status-sync-result'

function normalizeStatusMatchValue(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-')
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function mapBoardStatusToIssueState(
  targetStatus: WorkspaceStatusDefinition
): 'open' | 'closed' | null {
  const candidates = [
    normalizeStatusMatchValue(targetStatus.id),
    normalizeStatusMatchValue(targetStatus.label)
  ]
  if (candidates.some((value) => ['done', 'complete', 'completed', 'closed'].includes(value))) {
    return 'closed'
  }
  if (
    candidates.some((value) =>
      ['todo', 'to-do', 'open', 'in-progress', 'in-review', 'review', 'working'].includes(value)
    )
  ) {
    return 'open'
  }
  return null
}

function repoContextForWorktree(args: SyncWorkspaceBoardTaskStatusesArgs, worktreeId: string) {
  const worktree = args.worktreesById.get(worktreeId)
  const repoId = worktree?.sourceRepoId ?? worktree?.repoId
  return repoId ? (args.repoById?.get(repoId) ?? null) : null
}

function settingsForWorktree(args: SyncWorkspaceBoardTaskStatusesArgs, worktreeId: string) {
  return args.getSettingsForWorktree ? args.getSettingsForWorktree(worktreeId) : args.settings
}

async function syncGitHubWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const syncResult = createTaskStatusSyncResult()
  const worktree = args.worktreesById.get(worktreeId)
  const issueNumber = worktree?.linkedIssue
  if (!isPositiveNumber(issueNumber)) {
    return markTaskStatusSyncSkipped(syncResult)
  }
  if (worktree?.linkedPR === issueNumber) {
    return markTaskStatusSyncSkipped(syncResult, {
      kind: 'unsupported-linked-item-kind',
      provider: 'GitHub',
      issueNumber
    })
  }
  const repo = repoContextForWorktree(args, worktreeId)
  if (!repo) {
    return markTaskStatusSyncSkipped(syncResult, {
      kind: 'repo-context-missing',
      provider: 'GitHub',
      issueNumber
    })
  }
  const state = mapBoardStatusToIssueState(args.targetStatus)
  if (!state) {
    return markTaskStatusSyncSkipped(syncResult, {
      kind: 'missing-provider-status-mapping',
      provider: 'GitHub',
      statusLabel: args.targetStatus.label
    })
  }
  // Why: if board status changed while provider calls were in flight, skip this
  // transition so an older move cannot overwrite a newer local status.
  if (args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id) {
    return markTaskStatusSyncSkipped(syncResult)
  }
  try {
    const repoIssueSourcePreference =
      repo.issueSourcePreference === 'origin' || repo.issueSourcePreference === 'upstream'
        ? repo.issueSourcePreference
        : undefined
    const linkedIssueSourcePreference =
      worktree?.linkedIssueSourcePreference ?? repoIssueSourcePreference
    const updateResult = await deps.updateGitHubIssue(settingsForWorktree(args, worktreeId), {
      repoPath: repo.path,
      repoId: repo.id,
      issueSourcePreference: linkedIssueSourcePreference,
      number: issueNumber,
      updates: { state }
    })
    if (updateResult.ok === false) {
      return markTaskStatusSyncFailed(syncResult, {
        kind: 'update-failed',
        provider: 'GitHub',
        issueIdentifier: `#${issueNumber}`,
        detail: updateResult.error
      })
    }
    syncResult.updated += 1
    return syncResult
  } catch (error) {
    return markTaskStatusSyncFailed(syncResult, {
      kind: 'provider-error',
      provider: 'GitHub',
      issueIdentifier: `#${issueNumber}`,
      detail: error instanceof Error ? error.message : undefined
    })
  }
}

async function syncGitLabWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const syncResult = createTaskStatusSyncResult()
  const worktree = args.worktreesById.get(worktreeId)
  const issueNumber = worktree?.linkedGitLabIssue
  if (!isPositiveNumber(issueNumber)) {
    return markTaskStatusSyncSkipped(syncResult)
  }
  const repo = repoContextForWorktree(args, worktreeId)
  if (!repo) {
    return markTaskStatusSyncSkipped(syncResult, {
      kind: 'repo-context-missing',
      provider: 'GitLab',
      issueNumber
    })
  }
  const githubState = mapBoardStatusToIssueState(args.targetStatus)
  if (!githubState) {
    return markTaskStatusSyncSkipped(syncResult, {
      kind: 'missing-provider-status-mapping',
      provider: 'GitLab',
      statusLabel: args.targetStatus.label
    })
  }
  if (args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id) {
    return markTaskStatusSyncSkipped(syncResult)
  }
  try {
    const updates: GitLabIssueUpdate = { state: githubState === 'open' ? 'opened' : 'closed' }
    const updateResult = await deps.updateGitLabIssue(settingsForWorktree(args, worktreeId), {
      repoPath: repo.path,
      repoId: repo.id,
      number: issueNumber,
      projectRef: worktree?.linkedGitLabProjectRef ?? undefined,
      updates
    })
    if (updateResult.ok === false) {
      return markTaskStatusSyncFailed(syncResult, {
        kind: 'update-failed',
        provider: 'GitLab',
        issueIdentifier: `#${issueNumber}`,
        detail: updateResult.error
      })
    }
    syncResult.updated += 1
    return syncResult
  } catch (error) {
    return markTaskStatusSyncFailed(syncResult, {
      kind: 'provider-error',
      provider: 'GitLab',
      issueIdentifier: `#${issueNumber}`,
      detail: error instanceof Error ? error.message : undefined
    })
  }
}

export function syncNonLinearWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> | WorkspaceBoardTaskStatusSyncResult {
  const worktree = args.worktreesById.get(worktreeId)
  if (worktree?.linkedJiraIssue) {
    return syncJiraWorktreeStatus(args, worktreeId, deps, settingsForWorktree(args, worktreeId))
  }
  if (isPositiveNumber(worktree?.linkedGitLabIssue)) {
    return syncGitLabWorktreeStatus(args, worktreeId, deps)
  }
  if (isPositiveNumber(worktree?.linkedIssue)) {
    return syncGitHubWorktreeStatus(args, worktreeId, deps)
  }
  return markTaskStatusSyncSkipped(createTaskStatusSyncResult())
}
