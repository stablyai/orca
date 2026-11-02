import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  selectWorkspaceByHostTarget,
  type WorkspaceRecordState
} from '@/store/workspace-record-selectors'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { warnAmbiguousOwnerOnce } from '@/lib/ambiguous-owner-warning'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { translate } from '@/i18n/i18n'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
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
    case 'owner-ambiguous':
      return translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.f0a1b2c3d4',
        'Skipped Linear issue {{value0}}: this workspace is on more than one host.',
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

/** Linear settings of the worktree's owner, or `null` when its captured copy is gone or ambiguous. */
export function linearSettingsForBoardWorktree(
  state: WorktreeOperationRouteState & WorkspaceRecordState,
  worktreeId: string,
  /** The card's own host, retained even if its same-id copies change while queued. */
  hostId?: ExecutionHostId
): RuntimeLinearSettings | null {
  if (
    hostId &&
    !selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: worktreeId, hostId }))
  ) {
    return null
  }
  const target = hostId
    ? runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId, hostId })
    : getRuntimeTargetForWorktreeOwner(state, worktreeId)
  if (!target) {
    warnAmbiguousOwnerOnce(worktreeId, 'sync a board task status')
  }
  return target
}

export function useWorkspaceBoardTaskStatusSync(args: {
  enabled: boolean
  /** Board cards by host identity, so each same-id copy syncs through its own host. */
  worktreesByKey: ReadonlyMap<string, Worktree>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): (worktreeKeys: readonly string[], status: WorkspaceStatus) => void {
  return useCallback(
    (worktreeKeys, status) => {
      const request = getWorkspaceBoardTaskStatusSyncRequest({
        enabled: args.enabled,
        worktreeKeys,
        status,
        worktreesByKey: args.worktreesByKey,
        workspaceStatuses: args.workspaceStatuses
      })
      if (!request) {
        return
      }
      void syncWorkspaceBoardTaskStatuses({
        worktreeKeys: request.worktreeKeys,
        targetStatus: request.targetStatus,
        worktreesByKey: args.worktreesByKey,
        getSettingsForWorktree: (key) => {
          const worktree = args.worktreesByKey.get(key)
          return worktree
            ? linearSettingsForBoardWorktree(useAppStore.getState(), worktree.id, worktree.hostId)
            : null
        },
        getLatestWorkspaceStatus: (key) => {
          const worktree = args.worktreesByKey.get(key)
          if (!worktree) {
            return undefined
          }
          const state = useAppStore.getState()
          return worktree.hostId
            ? selectWorkspaceByHostTarget(
                state,
                hostWorktreeTarget({ id: worktree.id, hostId: worktree.hostId })
              )?.workspaceStatus
            : state.getKnownWorktreeById(worktree.id)?.workspaceStatus
        }
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
            failed: request.worktreeKeys.length,
            messages: [
              {
                kind: 'unexpected-error',
                detail: error instanceof Error ? error.message : undefined
              }
            ]
          })
        })
    },
    [args.enabled, args.workspaceStatuses, args.worktreesByKey]
  )
}
