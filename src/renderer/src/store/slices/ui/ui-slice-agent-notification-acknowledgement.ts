import type { AppState } from '../../types'
import { buildAgentNotificationId } from '../../../../../shared/agent-notification-id'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'

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
  ids,
  worktreeId,
  paneKey,
  stateStartedAt,
  previousAckAt
}: {
  ids: Set<string>
  worktreeId: string | null | undefined
  paneKey: string
  stateStartedAt: number | null | undefined
  previousAckAt: number
}): void {
  if (typeof stateStartedAt !== 'number' || previousAckAt >= stateStartedAt) {
    return
  }
  const id = buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt })
  if (id) {
    ids.add(id)
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
