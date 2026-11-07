import type { AppState } from '../../types'
import { buildAgentNotificationId } from '../../../../../shared/agent-notification-id'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolveTerminalNotificationOwner } from '@/attention/notification-subject-owner'
import { notificationExecutionHostForOwner } from '../../../../../shared/notification-source'
import { notificationDeliveryId } from '../../../../../shared/notification-delivery-id'

export function resolvePaneKeyWorktreeIdFromTabs(state: AppState, paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    if (tabs.some((tab) => tab.id === parsed.tabId)) {
      return worktreeId
    }
  }
  return null
}

export function collectAcknowledgedAgentNotificationId({
  state,
  ids,
  worktreeId,
  paneKey,
  ptyId,
  stateStartedAt,
  previousAckAt
}: {
  state: AppState
  ids: Set<string>
  worktreeId: string | null | undefined
  paneKey: string
  ptyId?: string | null
  stateStartedAt: number | null | undefined
  previousAckAt: number
}): void {
  if (!worktreeId || typeof stateStartedAt !== 'number' || previousAckAt >= stateStartedAt) {
    return
  }
  const id = buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt })
  if (id) {
    const owner = resolveTerminalNotificationOwner(state, worktreeId, { paneKey, ptyId })
    if (owner) {
      ids.add(notificationDeliveryId(id, notificationExecutionHostForOwner(owner)))
    }
  }
}

export {
  usableTimestamp,
  latestAgentTurnTimestamp
} from '../../../../../shared/agent-activity-read-state'
