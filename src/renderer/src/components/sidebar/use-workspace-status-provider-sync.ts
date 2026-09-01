import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { useAllWorktrees } from '@/store/selectors'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { formatOdooBoardStatusSyncDescription } from './odoo-board-status-sync-report'
import {
  syncOdooBoardStatuses,
  type OdooBoardStatusSyncResult
} from './workspace-board-odoo-status-sync'
import {
  getWorkspaceBoardTaskStatusSyncRequest,
  syncWorkspaceBoardTaskStatuses,
  type WorkspaceBoardTaskStatusSyncMessage,
  type WorkspaceBoardTaskStatusSyncResult
} from './workspace-board-task-status-sync'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
export function formatTaskStatusSyncMessage(message: WorkspaceBoardTaskStatusSyncMessage): string {
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

export function formatTaskStatusSyncDescription(
  result: WorkspaceBoardTaskStatusSyncResult
): string {
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

/**
 * Pushes a workspace-status change to every linked task provider.
 *
 * Reads its own inputs from the store so any surface that writes
 * `workspaceStatus` can call it — the board's drag-and-drop, but equally the
 * context-menu "Move to Status", which used to write locally and silently drop
 * the provider sync outside the board.
 */
export function useWorkspaceStatusProviderSync(): (
  worktreeIds: readonly string[],
  status: WorkspaceStatus
) => void {
  const allWorktrees = useAllWorktrees()
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const syncTaskStatusFromWorkspaceBoard = useAppStore((s) => s.syncTaskStatusFromWorkspaceBoard)
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )

  // Why: a stage that does not exist in Odoo used to fail into console.warn only,
  // so the card moved locally and the ticket silently stayed put. Odoo now reports
  // through the same toasts the Linear path already used.
  const reportOdooResult = useCallback((result: OdooBoardStatusSyncResult) => {
    if (result.failed === 0 && result.messages.length === 0) {
      return
    }
    const description = formatOdooBoardStatusSyncDescription(result)
    if (result.failed > 0) {
      toast.error(
        translate(
          'auto.components.sidebar.use.workspace.status.provider.sync.5af45b21e1',
          'Odoo sync failed'
        ),
        { description }
      )
      return
    }
    toast.warning(
      translate(
        'auto.components.sidebar.use.workspace.status.provider.sync.e82ea2f984',
        'Odoo sync skipped'
      ),
      { description }
    )
  }, [])

  const reportResult = useCallback((result: WorkspaceBoardTaskStatusSyncResult) => {
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
  }, [])

  return useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const request = getWorkspaceBoardTaskStatusSyncRequest({
        enabled: syncTaskStatusFromWorkspaceBoard,
        worktreeIds,
        status,
        worktreesById: worktreeById,
        workspaceStatuses
      })
      if (!request) {
        return
      }
      const providerArgs = {
        worktreeIds: request.worktreeIds,
        targetStatus: request.targetStatus,
        worktreesById: worktreeById,
        getSettingsForWorktree: (worktreeId: string) =>
          getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId),
        getLatestWorkspaceStatus: (worktreeId: string) =>
          useAppStore.getState().getKnownWorktreeById(worktreeId)?.workspaceStatus
      }
      // Odoo runs alongside Linear rather than instead of it: a workspace can
      // link a ticket, an issue, or both, and each provider ignores the others.
      void syncOdooBoardStatuses(providerArgs)
        .then((result) => {
          if (result.failed > 0) {
            console.warn('Workspace board Odoo stage sync result', result)
          }
          reportOdooResult(result)
        })
        .catch((error: unknown) => {
          console.warn('Workspace board Odoo stage sync failed', error)
          reportOdooResult({
            updated: 0,
            skipped: 0,
            failed: request.worktreeIds.length,
            messages: []
          })
        })
      void syncWorkspaceBoardTaskStatuses(providerArgs)
        .then((result) => {
          if (result.updated > 0 || result.failed > 0 || result.messages.length > 0) {
            console.info('Workspace board task status sync result', result)
          }
          reportResult(result)
        })
        .catch((error: unknown) => {
          console.warn('Workspace board task status sync failed', error)
          reportResult({
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
    [
      reportOdooResult,
      reportResult,
      syncTaskStatusFromWorkspaceBoard,
      workspaceStatuses,
      worktreeById
    ]
  )
}
