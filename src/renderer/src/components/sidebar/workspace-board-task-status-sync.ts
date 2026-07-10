import {
  linearGetIssue,
  linearTeamStates,
  linearUpdateIssue,
  type LinearMutationResult,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import type {
  LinearIssue,
  LinearWorkflowState,
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'

export type WorkspaceBoardTaskStatusSyncResult = {
  updated: number
  skipped: number
  failed: number
  messages: WorkspaceBoardTaskStatusSyncMessage[]
}

export type WorkspaceBoardTaskStatusSyncMessage =
  | { kind: 'issue-read-failed'; issueIdentifier: string }
  | { kind: 'missing-workflow-state'; statusLabel: string }
  | { kind: 'ambiguous-workflow-state'; statusLabel: string }
  | { kind: 'update-failed'; issueIdentifier: string; detail?: string }
  | { kind: 'provider-error'; issueIdentifier: string; detail?: string }
  | { kind: 'unexpected-error'; detail?: string }

type WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: typeof linearGetIssue
  teamStates: typeof linearTeamStates
  updateIssue: typeof linearUpdateIssue
}

export type SyncWorkspaceBoardTaskStatusesArgs = {
  worktreeIds: readonly string[]
  targetStatus: WorkspaceStatusDefinition
  worktreesById: ReadonlyMap<
    string,
    Pick<Worktree, 'linkedLinearIssue' | 'linkedLinearIssueWorkspaceId'>
  >
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
  updateIssue: linearUpdateIssue
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

  const settings = args.getSettingsForWorktree
    ? args.getSettingsForWorktree(worktreeId)
    : args.settings
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
        syncLinearWorktreeStatus(args, worktreeId, deps)
      )
      mergeResult(aggregate, item)
    })
  )

  return aggregate
}
