import type { AppState } from '../../types'
import { buildAgentNotificationId } from '../../../../../shared/agent-notification-id'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
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

export function usableTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Newest turn timestamp an unread check can compare against for one agent row. */
export function latestAgentTurnTimestamp(entry: {
  stateStartedAt?: number
  stateHistory?: { startedAt?: number }[]
}): number {
  let latest = usableTimestamp(entry.stateStartedAt)
  // Why history too: Activity renders one event per stateHistory entry, each with its own unread check.
  for (const history of entry.stateHistory ?? []) {
    latest = Math.max(latest, usableTimestamp(history.startedAt))
  }
  return latest
}
