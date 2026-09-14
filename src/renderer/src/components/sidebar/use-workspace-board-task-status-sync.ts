import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'
import {
  getWorkspaceBoardTaskStatusSyncRequest,
  syncWorkspaceBoardTaskStatuses,
  type WorkspaceBoardTaskStatusSyncMessage,
  type WorkspaceBoardTaskStatusSyncResult
} from './workspace-board-task-status-sync'

function formatTaskStatusSyncMessage(message: WorkspaceBoardTaskStatusSyncMessage): string {
  switch (message.kind) {
    case 'issue-read-failed':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.c1d2e3f4a5',
        'Linear issue {{value0}} could not be read.',
        { value0: message.issueIdentifier }
      )
    case 'missing-workflow-state':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.d2e3f4a5b6',
        'No matching Linear workflow state for {{value0}}.',
        { value0: message.statusLabel }
      )
    case 'ambiguous-workflow-state':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.e3f4a5b6c7',
        'Multiple Linear workflow states match {{value0}}.',
        { value0: message.statusLabel }
      )
    case 'update-failed':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.f4a5b6c7d8',
        'Could not update Linear issue {{value0}}.',
        { value0: message.issueIdentifier }
      )
    case 'provider-error':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.a5b6c7d8e9',
        'Could not sync Linear issue {{value0}}.',
        { value0: message.issueIdentifier }
      )
    case 'unexpected-error':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.b6c7d8e9f0',
        'Task status sync could not finish.'
      )
  }
}

function formatTaskStatusSyncDescription(result: WorkspaceBoardTaskStatusSyncResult): string {
  const counts = [
    result.updated > 0
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.c7d8e9f0a1',
          '{{value0}} updated',
          {
            value0: result.updated
          }
        )
      : null,
    result.skipped > 0
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.d8e9f0a1b2',
          '{{value0}} skipped',
          {
            value0: result.skipped
          }
        )
      : null,
    result.failed > 0
      ? translate('auto.components.sidebar.WorkspaceKanbanDrawer.e9f0a1b2c3', '{{value0}} failed', {
          value0: result.failed
        })
      : null
  ].filter((part): part is string => part !== null)
  return [
    counts.join(', '),
    result.messages[0] ? formatTaskStatusSyncMessage(result.messages[0]) : null
  ]
    .filter(Boolean)
    .join('. ')
}

function reportTaskStatusSyncResult(result: WorkspaceBoardTaskStatusSyncResult): void {
  if (result.failed === 0 && result.messages.length === 0) {
    return
  }
  const description = formatTaskStatusSyncDescription(result)
  if (result.failed > 0) {
    toast.error(
      translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.1975a4e480',
        'Task status sync failed'
      ),
      { description }
    )
    return
  }
  toast.warning(
    translate(
      'auto.components.sidebar.WorkspaceKanbanDrawer.e02b0d92ff',
      'Task status sync skipped'
    ),
    { description }
  )
}

export function useWorkspaceBoardTaskStatusSync(args: {
  enabled: boolean
  worktreesById: ReadonlyMap<string, Worktree>
  workspaceStatuses: ReturnType<typeof useAppStore.getState>['workspaceStatuses']
}): (worktreeIds: readonly string[], status: WorkspaceStatus) => void {
  return useCallback(
    (worktreeIds, status) => {
      const request = getWorkspaceBoardTaskStatusSyncRequest({
        enabled: args.enabled,
        worktreeIds,
        status,
        worktreesById: args.worktreesById,
        workspaceStatuses: args.workspaceStatuses
      })
      if (!request) {
        return
      }
      void syncWorkspaceBoardTaskStatuses({
        worktreeIds: request.worktreeIds,
        targetStatus: request.targetStatus,
        worktreesById: args.worktreesById,
        getSettingsForWorktree: (worktreeId) =>
          getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId),
        getLatestWorkspaceStatus: (worktreeId) =>
          useAppStore.getState().getKnownWorktreeById(worktreeId)?.workspaceStatus
      })
        .then((result) => {
          if (result.updated > 0 || result.failed > 0 || result.messages.length > 0) {
            console.info('Workspace board task status sync result', result)
          }
          reportTaskStatusSyncResult(result)
        })
        .catch((error: unknown) => {
          console.warn('Workspace board task status sync failed', error)
          reportTaskStatusSyncResult({
            updated: 0,
            skipped: 0,
            failed: request.worktreeIds.length,
            messages: [
              {
                kind: 'unexpected-error',
                detail: error instanceof Error ? error.message : undefined
              }
            ]
          })
        })
    },
    [args.enabled, args.workspaceStatuses, args.worktreesById]
  )
}
