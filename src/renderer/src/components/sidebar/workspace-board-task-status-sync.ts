import {
  linearGetIssue,
  linearTeamStates,
  linearUpdateIssue,
  type LinearMutationResult,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import { githubUpdateIssue } from '@/runtime/runtime-github-issue-client'
import { gitlabUpdateIssue } from '@/runtime/runtime-gitlab-issue-client'
import { jiraGetIssue, jiraListTransitions, jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type {
  LinearIssue,
  LinearWorkflowState,
  Repo,
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'
import { syncNonLinearWorktreeStatus } from './workspace-board-nonlinear-task-status-sync'
import {
  createTaskStatusSyncResult,
  markTaskStatusSyncFailed,
  markTaskStatusSyncSkipped,
  mergeTaskStatusSyncResult
} from './workspace-board-task-status-sync-result'

type TaskStatusSyncProvider = 'Linear' | 'GitHub' | 'GitLab' | 'Jira'

export type WorkspaceBoardTaskStatusSyncResult = {
  updated: number
  skipped: number
  failed: number
  messages: WorkspaceBoardTaskStatusSyncMessage[]
}

export type WorkspaceBoardTaskStatusSyncMessage =
  | { kind: 'issue-read-failed'; provider: TaskStatusSyncProvider; issueIdentifier: string }
  | { kind: 'linked-issue-missing'; provider: TaskStatusSyncProvider }
  | {
      kind: 'missing-provider-status-mapping'
      provider: TaskStatusSyncProvider
      statusLabel: string
    }
  | {
      kind: 'ambiguous-provider-status-mapping'
      provider: TaskStatusSyncProvider
      statusLabel: string
    }
  | { kind: 'repo-context-missing'; provider: 'GitHub' | 'GitLab'; issueNumber: number }
  | { kind: 'unsupported-linked-item-kind'; provider: 'GitHub'; issueNumber: number }
  | {
      kind: 'update-failed'
      provider: TaskStatusSyncProvider
      issueIdentifier: string
      detail?: string
    }
  | {
      kind: 'provider-error'
      provider: TaskStatusSyncProvider
      issueIdentifier: string
      detail?: string
    }
  | { kind: 'unexpected-error'; detail?: string }

export type WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: typeof linearGetIssue
  teamStates: typeof linearTeamStates
  updateIssue: typeof linearUpdateIssue
  updateGitHubIssue: typeof githubUpdateIssue
  updateGitLabIssue: typeof gitlabUpdateIssue
  getJiraIssue: typeof jiraGetIssue
  listJiraTransitions: typeof jiraListTransitions
  updateJiraIssue: typeof jiraUpdateIssue
}

export type SyncWorkspaceBoardTaskStatusesArgs = {
  worktreeIds: readonly string[]
  targetStatus: WorkspaceStatusDefinition
  worktreesById: ReadonlyMap<
    string,
    Pick<
      Worktree,
      | 'repoId'
      | 'sourceRepoId'
      | 'linkedIssue'
      | 'linkedIssueSourcePreference'
      | 'linkedPR'
      | 'linkedLinearIssue'
      | 'linkedLinearIssueWorkspaceId'
      | 'linkedJiraIssue'
      | 'linkedJiraIssueSiteId'
      | 'linkedGitLabIssue'
      | 'linkedGitLabProjectRef'
    >
  >
  repoById?: ReadonlyMap<string, Pick<Repo, 'id' | 'path' | 'issueSourcePreference'>>
  settings?: RuntimeLinearSettings
  getSettingsForWorktree?: (worktreeId: string) => RuntimeLinearSettings
  getLatestWorkspaceStatus: (worktreeId: string) => WorkspaceStatus | null | undefined
  deps?: Partial<WorkspaceBoardTaskStatusSyncDependencies>
}

export type WorkspaceBoardTaskStatusSyncRequest = {
  worktreeIds: string[]
  targetStatus: WorkspaceStatusDefinition
}

export function getWorkspaceBoardTaskStatusSyncRequest(args: {
  enabled: boolean
  worktreeIds: readonly string[]
  status: WorkspaceStatus
  worktreesById: ReadonlyMap<string, Pick<Worktree, 'workspaceStatus'>>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): WorkspaceBoardTaskStatusSyncRequest | null {
  if (!args.enabled || args.worktreeIds.length === 0) {
    return null
  }
  const targetStatus = args.workspaceStatuses.find((item) => item.id === args.status)
  if (!targetStatus) {
    return null
  }
  const changedWorktreeIds = [...new Set(args.worktreeIds)].filter((worktreeId) => {
    const worktree = args.worktreesById.get(worktreeId)
    return worktree ? getWorkspaceStatus(worktree, args.workspaceStatuses) !== args.status : false
  })
  if (changedWorktreeIds.length === 0) {
    return null
  }
  return { worktreeIds: changedWorktreeIds, targetStatus }
}

const defaultDeps: WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: linearGetIssue,
  teamStates: linearTeamStates,
  updateIssue: linearUpdateIssue,
  updateGitHubIssue: githubUpdateIssue,
  updateGitLabIssue: gitlabUpdateIssue,
  getJiraIssue: jiraGetIssue,
  listJiraTransitions: jiraListTransitions,
  updateJiraIssue: jiraUpdateIssue
}

const worktreeSyncQueues = new Map<string, Promise<unknown>>()

function normalizeStateName(name: string): string {
  return name.trim().toLowerCase()
}

function matchingWorkflowStates(
  states: readonly LinearWorkflowState[],
  targetStatus: WorkspaceStatusDefinition
): LinearWorkflowState[] {
  const targetName = normalizeStateName(targetStatus.label)
  return states.filter((state) => normalizeStateName(state.name) === targetName)
}

function isAlreadyInState(issue: LinearIssue, workflowState: LinearWorkflowState): boolean {
  return (
    normalizeStateName(issue.state.name) === normalizeStateName(workflowState.name) &&
    issue.state.type === workflowState.type
  )
}

async function enqueueWorktreeSync(
  worktreeId: string,
  task: () => Promise<WorkspaceBoardTaskStatusSyncResult>
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const previous = worktreeSyncQueues.get(worktreeId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  const cleanup = next.finally(() => {
    if (worktreeSyncQueues.get(worktreeId) === cleanup) {
      worktreeSyncQueues.delete(worktreeId)
    }
  })
  worktreeSyncQueues.set(worktreeId, cleanup)
  return next
}

async function syncLinearWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const result = createTaskStatusSyncResult()
  const worktree = args.worktreesById.get(worktreeId)
  if (!worktree?.linkedLinearIssue) {
    return markTaskStatusSyncSkipped(result)
  }

  const settings = args.getSettingsForWorktree
    ? args.getSettingsForWorktree(worktreeId)
    : args.settings
  const linkedWorkspaceId = worktree.linkedLinearIssueWorkspaceId ?? undefined

  try {
    const issue = await deps.getIssue(settings, worktree.linkedLinearIssue, linkedWorkspaceId)
    if (!issue?.team?.id) {
      return markTaskStatusSyncSkipped(result, {
        kind: 'issue-read-failed',
        provider: 'Linear',
        issueIdentifier: worktree.linkedLinearIssue
      })
    }

    const workspaceId = linkedWorkspaceId ?? issue.workspaceId
    const states = await deps.teamStates(settings, issue.team.id, workspaceId)
    const matches = matchingWorkflowStates(states, args.targetStatus)
    if (matches.length === 0) {
      return markTaskStatusSyncSkipped(result, {
        kind: 'missing-provider-status-mapping',
        provider: 'Linear',
        statusLabel: args.targetStatus.label
      })
    }
    if (matches.length > 1) {
      return markTaskStatusSyncSkipped(result, {
        kind: 'ambiguous-provider-status-mapping',
        provider: 'Linear',
        statusLabel: args.targetStatus.label
      })
    }

    const [workflowState] = matches
    if (isAlreadyInState(issue, workflowState)) {
      return markTaskStatusSyncSkipped(result)
    }

    // Why: board moves are local-first; slow provider reads must not let an
    // older board move overwrite a newer local status in Linear.
    if (args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id) {
      return markTaskStatusSyncSkipped(result)
    }

    const updateResult: LinearMutationResult = await deps.updateIssue(
      settings,
      issue.id,
      { stateId: workflowState.id },
      workspaceId
    )
    if (updateResult.ok === false) {
      return markTaskStatusSyncFailed(result, {
        kind: 'update-failed',
        provider: 'Linear',
        issueIdentifier: issue.identifier,
        detail: updateResult.error
      })
    }
    result.updated += 1
    return result
  } catch (error) {
    return markTaskStatusSyncFailed(result, {
      kind: 'provider-error',
      provider: 'Linear',
      issueIdentifier: worktree.linkedLinearIssue,
      detail: error instanceof Error ? error.message : undefined
    })
  }
}

async function syncWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const worktree = args.worktreesById.get(worktreeId)
  if (worktree?.linkedLinearIssue) {
    return syncLinearWorktreeStatus(args, worktreeId, deps)
  }
  return syncNonLinearWorktreeStatus(args, worktreeId, deps)
}

export async function syncWorkspaceBoardTaskStatuses(
  args: SyncWorkspaceBoardTaskStatusesArgs
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const deps = { ...defaultDeps, ...args.deps }
  const aggregate = createTaskStatusSyncResult()

  const uniqueIds = new Set(args.worktreeIds)
  await Promise.all(
    [...uniqueIds].map(async (worktreeId) => {
      const item = await enqueueWorktreeSync(worktreeId, () =>
        syncWorktreeStatus(args, worktreeId, deps)
      )
      mergeTaskStatusSyncResult(aggregate, item)
    })
  )

  return aggregate
}
