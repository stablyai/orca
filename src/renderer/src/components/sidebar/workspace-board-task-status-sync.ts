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
  | { kind: 'owner-ambiguous'; issueIdentifier: string }
  | { kind: 'unexpected-error'; detail?: string }

type WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: typeof linearGetIssue
  teamStates: typeof linearTeamStates
  updateIssue: typeof linearUpdateIssue
}

/** Cards are keyed by host identity: same-id copies on two hosts each sync their own linked issue. */
export type SyncWorkspaceBoardTaskStatusesArgs = {
  worktreeKeys: readonly string[]
  targetStatus: WorkspaceStatusDefinition
  worktreesByKey: ReadonlyMap<
    string,
    Pick<Worktree, 'linkedLinearIssue' | 'linkedLinearIssueWorkspaceId'>
  >
  settings?: RuntimeLinearSettings
  /** `null` refuses the worktree: its owner is ambiguous, so no host's Linear settings apply. */
  getSettingsForWorktree?: (worktreeKey: string) => RuntimeLinearSettings | null
  getLatestWorkspaceStatus: (worktreeKey: string) => WorkspaceStatus | null | undefined
  deps?: Partial<WorkspaceBoardTaskStatusSyncDependencies>
}

export type WorkspaceBoardTaskStatusSyncRequest = {
  worktreeKeys: string[]
  targetStatus: WorkspaceStatusDefinition
}

export function getWorkspaceBoardTaskStatusSyncRequest(args: {
  enabled: boolean
  worktreeKeys: readonly string[]
  status: WorkspaceStatus
  worktreesByKey: ReadonlyMap<string, Pick<Worktree, 'workspaceStatus'>>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): WorkspaceBoardTaskStatusSyncRequest | null {
  if (!args.enabled || args.worktreeKeys.length === 0) {
    return null
  }
  const targetStatus = args.workspaceStatuses.find((item) => item.id === args.status)
  if (!targetStatus) {
    return null
  }
  const changedWorktreeKeys = [...new Set(args.worktreeKeys)].filter((key) => {
    const worktree = args.worktreesByKey.get(key)
    return worktree ? getWorkspaceStatus(worktree, args.workspaceStatuses) !== args.status : false
  })
  if (changedWorktreeKeys.length === 0) {
    return null
  }
  return { worktreeKeys: changedWorktreeKeys, targetStatus }
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
  worktreeKey: string,
  task: () => Promise<WorkspaceBoardTaskStatusSyncResult>
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const previous = worktreeSyncQueues.get(worktreeKey) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  const cleanup = next.finally(() => {
    if (worktreeSyncQueues.get(worktreeKey) === cleanup) {
      worktreeSyncQueues.delete(worktreeKey)
    }
  })
  worktreeSyncQueues.set(worktreeKey, cleanup)
  return next
}

async function syncLinearWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeKey: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const result: WorkspaceBoardTaskStatusSyncResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    messages: []
  }
  const worktree = args.worktreesByKey.get(worktreeKey)
  if (!worktree?.linkedLinearIssue) {
    return skipped(result)
  }

  // Legacy callers without source settings route to this computer.
  const settings = args.getSettingsForWorktree
    ? args.getSettingsForWorktree(worktreeKey)
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

    // Board moves are local-first; a slow provider read must not let an older move overwrite a newer one.
    if (args.getLatestWorkspaceStatus(worktreeKey) !== args.targetStatus.id) {
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

  const uniqueKeys = new Set(args.worktreeKeys)
  await Promise.all(
    [...uniqueKeys].map(async (worktreeKey) => {
      const item = await enqueueWorktreeSync(worktreeKey, () =>
        syncLinearWorktreeStatus(args, worktreeKey, deps)
      )
      mergeResult(aggregate, item)
    })
  )

  return aggregate
}
