import { linearGetIssue, linearUpdateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { linearTeamStates } from '@/runtime/runtime-linear-project-client'
import type { LinearMutationResult, RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearWorkflowState } from '../../../../shared/linear/workspace-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
import {
  DEFAULT_WORKSPACE_BOARD_CLICKUP_STATUS_SYNC_DEPS,
  syncClickUpWorktreeStatus,
  type WorkspaceBoardClickUpStatusSyncDependencies
} from './workspace-board-clickup-status-sync'
export { getWorkspaceBoardTaskStatusSyncRequest } from './workspace-board-task-status-sync-request'

export type WorkspaceBoardTaskStatusSyncResult = {
  updated: number
  skipped: number
  failed: number
  messages: WorkspaceBoardTaskStatusSyncMessage[]
}

export type WorkspaceBoardTaskStatusSyncMessage =
  | { kind: 'issue-read-failed'; issueIdentifier: string; provider?: 'ClickUp' }
  | { kind: 'missing-workflow-state'; statusLabel: string; provider?: 'ClickUp' }
  | { kind: 'ambiguous-workflow-state'; statusLabel: string; provider?: 'ClickUp' }
  | { kind: 'update-failed'; issueIdentifier: string; detail?: string; provider?: 'ClickUp' }
  | { kind: 'provider-error'; issueIdentifier: string; detail?: string; provider?: 'ClickUp' }
  | { kind: 'owner-ambiguous'; issueIdentifier: string }
  | { kind: 'unexpected-error'; detail?: string }

type WorkspaceBoardTaskStatusSyncDependencies = WorkspaceBoardClickUpStatusSyncDependencies & {
  getIssue: typeof linearGetIssue
  teamStates: typeof linearTeamStates
  updateIssue: typeof linearUpdateIssue
}

export type SyncWorkspaceBoardTaskStatusesArgs = {
  worktreeIds: readonly string[]
  targetStatus: WorkspaceStatusDefinition
  worktreesById: ReadonlyMap<
    string,
    Pick<
      Worktree,
      | 'linkedLinearIssue'
      | 'linkedLinearIssueWorkspaceId'
      | 'linkedClickUpTaskId'
      | 'linkedClickUpWorkspaceId'
    >
  >
  // Why: Linear and ClickUp are both row-less sources, so one routing shape serves both.
  settings?: RuntimeLinearSettings
  /** `null` refuses the worktree: its owner is ambiguous, so no host's Linear settings apply. */
  getSettingsForWorktree?: (worktreeId: string) => RuntimeLinearSettings | null
  getLatestWorkspaceStatus: (worktreeId: string) => WorkspaceStatus | null | undefined
  deps?: Partial<WorkspaceBoardTaskStatusSyncDependencies>
}

const defaultDeps: WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: linearGetIssue,
  teamStates: linearTeamStates,
  updateIssue: linearUpdateIssue,
  ...DEFAULT_WORKSPACE_BOARD_CLICKUP_STATUS_SYNC_DEPS
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

function getMessageKey(message: WorkspaceBoardTaskStatusSyncMessage): string {
  return JSON.stringify(message)
}

function addMessage(
  result: WorkspaceBoardTaskStatusSyncResult,
  message: WorkspaceBoardTaskStatusSyncMessage
): void {
  const key = getMessageKey(message)
  if (!result.messages.some((item) => getMessageKey(item) === key)) {
    result.messages.push(message)
  }
}

function skipped(
  result: WorkspaceBoardTaskStatusSyncResult,
  message?: WorkspaceBoardTaskStatusSyncMessage
): WorkspaceBoardTaskStatusSyncResult {
  result.skipped += 1
  if (message) {
    addMessage(result, message)
  }
  return result
}

function failed(
  result: WorkspaceBoardTaskStatusSyncResult,
  message: WorkspaceBoardTaskStatusSyncMessage
): WorkspaceBoardTaskStatusSyncResult {
  result.failed += 1
  addMessage(result, message)
  return result
}

function isAlreadyInState(issue: LinearIssue, workflowState: LinearWorkflowState): boolean {
  return (
    normalizeStateName(issue.state.name) === normalizeStateName(workflowState.name) &&
    issue.state.type === workflowState.type
  )
}

function mergeResult(
  aggregate: WorkspaceBoardTaskStatusSyncResult,
  item: WorkspaceBoardTaskStatusSyncResult
): void {
  aggregate.updated += item.updated
  aggregate.skipped += item.skipped
  aggregate.failed += item.failed
  for (const message of item.messages) {
    addMessage(aggregate, message)
  }
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
  const result: WorkspaceBoardTaskStatusSyncResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    messages: []
  }
  const worktree = args.worktreesById.get(worktreeId)
  if (!worktree?.linkedLinearIssue) {
    return skipped(result)
  }

  // Why: no source has always meant this computer.
  const settings = args.getSettingsForWorktree
    ? args.getSettingsForWorktree(worktreeId)
    : (args.settings ?? { kind: 'local' })
  if (!settings) {
    return skipped(result, { kind: 'owner-ambiguous', issueIdentifier: worktree.linkedLinearIssue })
  }
  const linkedWorkspaceId = worktree.linkedLinearIssueWorkspaceId ?? undefined

  try {
    const issue = await deps.getIssue(settings, worktree.linkedLinearIssue, linkedWorkspaceId)
    if (!issue?.team?.id) {
      return skipped(result, {
        kind: 'issue-read-failed',
        issueIdentifier: worktree.linkedLinearIssue
      })
    }

    const workspaceId = linkedWorkspaceId ?? issue.workspaceId
    const states = await deps.teamStates(settings, issue.team.id, workspaceId)
    const matches = matchingWorkflowStates(states, args.targetStatus)
    if (matches.length === 0) {
      return skipped(result, {
        kind: 'missing-workflow-state',
        statusLabel: args.targetStatus.label
      })
    }
    if (matches.length > 1) {
      return skipped(result, {
        kind: 'ambiguous-workflow-state',
        statusLabel: args.targetStatus.label
      })
    }

    const [workflowState] = matches
    if (isAlreadyInState(issue, workflowState)) {
      return skipped(result)
    }

    // Why: board moves are local-first; slow provider reads must not let an
    // older board move overwrite a newer local status in Linear.
    if (args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id) {
      return skipped(result)
    }

    const updateResult: LinearMutationResult = await deps.updateIssue(
      settings,
      issue.id,
      { stateId: workflowState.id },
      workspaceId
    )
    if (updateResult.ok === false) {
      return failed(result, {
        kind: 'update-failed',
        issueIdentifier: issue.identifier,
        detail: updateResult.error
      })
    }
    result.updated += 1
    return result
  } catch (error) {
    return failed(result, {
      kind: 'provider-error',
      issueIdentifier: worktree.linkedLinearIssue,
      detail: error instanceof Error ? error.message : undefined
    })
  }
}

async function syncWorktreeTaskStatuses(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeId: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const worktree = args.worktreesById.get(worktreeId)
  if (!worktree?.linkedLinearIssue && !worktree?.linkedClickUpTaskId) {
    return { updated: 0, skipped: 1, failed: 0, messages: [] }
  }
  const aggregate: WorkspaceBoardTaskStatusSyncResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    messages: []
  }
  const results = await Promise.all([
    ...(worktree.linkedLinearIssue ? [syncLinearWorktreeStatus(args, worktreeId, deps)] : []),
    ...(worktree.linkedClickUpTaskId ? [syncClickUpWorktreeStatus(args, worktreeId, deps)] : [])
  ])
  for (const result of results) {
    mergeResult(aggregate, result)
  }
  return aggregate
}

export async function syncWorkspaceBoardTaskStatuses(
  args: SyncWorkspaceBoardTaskStatusesArgs
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const deps = { ...defaultDeps, ...args.deps }
  const aggregate: WorkspaceBoardTaskStatusSyncResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    messages: []
  }

  const uniqueIds = new Set(args.worktreeIds)
  await Promise.all(
    [...uniqueIds].map(async (worktreeId) => {
      const item = await enqueueWorktreeSync(worktreeId, () =>
        syncWorktreeTaskStatuses(args, worktreeId, deps)
      )
      mergeResult(aggregate, item)
    })
  )

  return aggregate
}
