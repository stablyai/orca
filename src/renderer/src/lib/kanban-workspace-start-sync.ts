import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { KanbanMarkStartedResult } from '../../../shared/kanban-types'

export type KanbanSyncLinkedItem = {
  provider?: string
  kanbanIdentifier?: string
}

export function getKanbanTaskIdFromLinkedItem(
  linkedWorkItem: KanbanSyncLinkedItem | null | undefined
): string | null {
  return linkedWorkItem?.provider === 'kanban' && linkedWorkItem.kanbanIdentifier
    ? linkedWorkItem.kanbanIdentifier
    : null
}

function networkFailureResult(
  retry: 'all' | 'comment-only'
): Extract<KanbanMarkStartedResult, { ok: false }> {
  return {
    ok: false,
    moved: false,
    commented: false,
    retry,
    code: 'network',
    message: translate(
      'auto.components.kanban.sync.networkError',
      'Kanban is unreachable. Check your connection.'
    )
  }
}

export function showKanbanCardUpdateToast(args: {
  taskId: string
  projectName: string
  branch: string | null
  result: Extract<KanbanMarkStartedResult, { ok: false }>
}): void {
  // Why: the main process already decided the exact retry mode; a failed
  // comment-only retry must stay comment-only instead of restarting from `all`.
  const retry = args.result.retry
  toast.error(
    translate('auto.components.kanban.sync.failed', 'Не удалось обновить карточку Kanban.'),
    {
      description: args.result.message,
      duration: Infinity,
      dismissible: true,
      action: {
        label: translate('auto.components.kanban.sync.retry', 'Повторить обновление карточки'),
        onClick: () => {
          void retryKanbanCardUpdate(args.taskId, args.projectName, args.branch, retry)
        }
      }
    }
  )
}

export async function retryKanbanCardUpdate(
  taskId: string,
  projectName: string,
  branch: string | null,
  retry: 'all' | 'comment-only'
): Promise<void> {
  try {
    const result = await window.api.kanban.markStarted({ taskId, projectName, branch, retry })
    if (!result.ok) {
      showKanbanCardUpdateToast({ taskId, projectName, branch, result })
    } else {
      // Why: the card moved/updated — refresh the Kanban task list via the
      // store-backed nonce the Task Page list fetch already watches.
      useAppStore.getState().requestKanbanTaskRefresh()
    }
  } catch {
    showKanbanCardUpdateToast({
      taskId,
      projectName,
      branch,
      result: networkFailureResult(retry)
    })
  }
}

/**
 * Invoke the card move+comment after a workspace was created, persisted and
 * activated. No-op for non-Kanban linked items and never throws, so a board
 * failure cannot fail or roll back workspace creation.
 */
export async function syncKanbanTaskAfterWorkspaceStart(args: {
  linkedWorkItem: KanbanSyncLinkedItem | null | undefined
  projectName: string
  branch: string | null
}): Promise<void> {
  const taskId = getKanbanTaskIdFromLinkedItem(args.linkedWorkItem)
  if (!taskId) {
    return
  }
  await retryKanbanCardUpdate(taskId, args.projectName, args.branch, 'all')
}
