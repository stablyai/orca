import {
  clickUpGetTask,
  clickUpUpdateTask,
  type RuntimeClickUpSettings
} from '@/runtime/runtime-clickup-client'
import type { ClickUpMutationResult, ClickUpTask } from '../../../../shared/clickup-types'
import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceBoardTaskStatusSyncResult } from './workspace-board-task-status-sync'

export type WorkspaceBoardClickUpStatusSyncDependencies = {
  getClickUpTask: typeof clickUpGetTask
  updateClickUpTask: typeof clickUpUpdateTask
}

type WorkspaceBoardClickUpStatusSyncArgs = {
  targetStatus: WorkspaceStatusDefinition
  worktreesById: ReadonlyMap<
    string,
    Pick<Worktree, 'linkedClickUpTaskId' | 'linkedClickUpWorkspaceId'>
  >
  settings?: RuntimeClickUpSettings
  getSettingsForWorktree?: (worktreeId: string) => RuntimeClickUpSettings
  getLatestWorkspaceStatus: (worktreeId: string) => WorkspaceStatus | null | undefined
}

export const DEFAULT_WORKSPACE_BOARD_CLICKUP_STATUS_SYNC_DEPS: WorkspaceBoardClickUpStatusSyncDependencies =
  {
    getClickUpTask: clickUpGetTask,
    updateClickUpTask: clickUpUpdateTask
  }

function emptyResult(): WorkspaceBoardTaskStatusSyncResult {
  return { updated: 0, skipped: 0, failed: 0, messages: [] }
}

function normalizedStatusName(name: string): string {
  return name.trim().toLowerCase()
}

function taskIdentifier(task: ClickUpTask): string {
  return task.customId ?? task.id
}

export async function syncClickUpWorktreeStatus(
  args: WorkspaceBoardClickUpStatusSyncArgs,
  worktreeId: string,
  deps: WorkspaceBoardClickUpStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const result = emptyResult()
  const worktree = args.worktreesById.get(worktreeId)
  if (!worktree?.linkedClickUpTaskId) {
    result.skipped += 1
    return result
  }
  // Why: undefined intentionally routes through the local runtime when no owner-specific settings exist.
  const settings = args.getSettingsForWorktree
    ? args.getSettingsForWorktree(worktreeId)
    : args.settings
  const workspaceId = worktree.linkedClickUpWorkspaceId ?? undefined

  try {
    const task = await deps.getClickUpTask(settings, worktree.linkedClickUpTaskId, workspaceId)
    if (!task) {
      result.skipped += 1
      result.messages.push({
        kind: 'issue-read-failed',
        issueIdentifier: worktree.linkedClickUpTaskId,
        provider: 'ClickUp'
      })
      return result
    }
    if (
      normalizedStatusName(task.status.name) === normalizedStatusName(args.targetStatus.label) ||
      args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id
    ) {
      result.skipped += 1
      return result
    }
    // Why: ClickUp accepts the List's exact status name, while the board keeps
    // provider-neutral labels rather than provider-specific status IDs.
    const updateResult: ClickUpMutationResult = await deps.updateClickUpTask(
      settings,
      task.id,
      { status: args.targetStatus.label },
      workspaceId ?? task.workspaceId
    )
    if (updateResult.ok === false) {
      result.failed += 1
      result.messages.push({
        kind: 'update-failed',
        issueIdentifier: taskIdentifier(task),
        detail: updateResult.error,
        provider: 'ClickUp'
      })
      return result
    }
    result.updated += 1
    return result
  } catch (error) {
    result.failed += 1
    result.messages.push({
      kind: 'provider-error',
      issueIdentifier: worktree.linkedClickUpTaskId,
      detail: error instanceof Error ? error.message : undefined,
      provider: 'ClickUp'
    })
    return result
  }
}
