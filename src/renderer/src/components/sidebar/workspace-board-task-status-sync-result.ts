import type {
  WorkspaceBoardTaskStatusSyncMessage,
  WorkspaceBoardTaskStatusSyncResult
} from './workspace-board-task-status-sync'

export function createTaskStatusSyncResult(): WorkspaceBoardTaskStatusSyncResult {
  return { updated: 0, skipped: 0, failed: 0, messages: [] }
}

function getMessageKey(message: WorkspaceBoardTaskStatusSyncMessage): string {
  return JSON.stringify(message)
}

export function addTaskStatusSyncMessage(
  result: WorkspaceBoardTaskStatusSyncResult,
  message: WorkspaceBoardTaskStatusSyncMessage
): void {
  const key = getMessageKey(message)
  if (!result.messages.some((item) => getMessageKey(item) === key)) {
    result.messages.push(message)
  }
}

export function markTaskStatusSyncSkipped(
  result: WorkspaceBoardTaskStatusSyncResult,
  message?: WorkspaceBoardTaskStatusSyncMessage
): WorkspaceBoardTaskStatusSyncResult {
  result.skipped += 1
  if (message) {
    addTaskStatusSyncMessage(result, message)
  }
  return result
}

export function markTaskStatusSyncFailed(
  result: WorkspaceBoardTaskStatusSyncResult,
  message: WorkspaceBoardTaskStatusSyncMessage
): WorkspaceBoardTaskStatusSyncResult {
  result.failed += 1
  addTaskStatusSyncMessage(result, message)
  return result
}

export function mergeTaskStatusSyncResult(
  aggregate: WorkspaceBoardTaskStatusSyncResult,
  item: WorkspaceBoardTaskStatusSyncResult
): void {
  aggregate.updated += item.updated
  aggregate.skipped += item.skipped
  aggregate.failed += item.failed
  for (const message of item.messages) {
    addTaskStatusSyncMessage(aggregate, message)
  }
}
