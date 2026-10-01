import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { useAppStore, type AppState } from '@/store'
import { selectWorktreeActivityStatuses } from './use-worktree-activity-statuses'

export type LineageHiddenActivityStatus = Extract<
  WorktreeStatus,
  'permission' | 'failed' | 'working' | 'monitoring' | 'interrupted'
>

/** How many hidden worktrees are in each attention-worthy state. */
export type LineageHiddenActivity = Record<LineageHiddenActivityStatus, number>

// Why: the card's own resolveWorktreeStatus order, so the chip ranks hidden
// children the way their cards would; done and idle children stay quiet.
const ACTIVITY_PRIORITY: readonly LineageHiddenActivityStatus[] = [
  'permission',
  'failed',
  'working',
  'monitoring',
  'interrupted'
]
const ACTIVITY_STATUSES: ReadonlySet<WorktreeStatus> = new Set(ACTIVITY_PRIORITY)

function isLineageHiddenActivityStatus(
  status: WorktreeStatus
): status is LineageHiddenActivityStatus {
  return ACTIVITY_STATUSES.has(status)
}

export function summarizeLineageHiddenActivity(
  statuses: Iterable<WorktreeStatus>
): LineageHiddenActivity {
  const activity: LineageHiddenActivity = {
    permission: 0,
    failed: 0,
    working: 0,
    monitoring: 0,
    interrupted: 0
  }
  for (const status of statuses) {
    if (isLineageHiddenActivityStatus(status)) {
      activity[status] += 1
    }
  }
  return activity
}

export function getLineageHiddenActivityStatus(
  activity: LineageHiddenActivity
): LineageHiddenActivityStatus | null {
  return ACTIVITY_PRIORITY.find((status) => activity[status] > 0) ?? null
}

function getActivityCountLabel(status: LineageHiddenActivityStatus, count: number): string {
  if (status === 'permission') {
    return translate(
      'auto.components.sidebar.WorktreeLineageHiddenActivity.permission',
      '{{value0}} waiting for permission',
      { value0: count }
    )
  }
  if (status === 'failed') {
    return translate(
      'auto.components.sidebar.WorktreeLineageHiddenActivity.failed',
      '{{value0}} failed',
      { value0: count }
    )
  }
  if (status === 'working') {
    return translate(
      'auto.components.sidebar.WorktreeLineageHiddenActivity.working',
      '{{value0}} working',
      { value0: count }
    )
  }
  if (status === 'interrupted') {
    return translate(
      'auto.components.sidebar.WorktreeLineageHiddenActivity.interrupted',
      '{{value0}} interrupted',
      { value0: count }
    )
  }
  return translate(
    'auto.components.sidebar.WorktreeLineageHiddenActivity.monitoring',
    '{{value0}} monitoring background tasks',
    { value0: count }
  )
}

/** States first, then unread: a finished child is news the parent row otherwise hides. */
export function getLineageHiddenActivityLabel(
  activity: LineageHiddenActivity,
  unreadCount: number
): string | null {
  const parts = ACTIVITY_PRIORITY.filter((status) => activity[status] > 0).map((status) =>
    getActivityCountLabel(status, activity[status])
  )
  if (unreadCount > 0) {
    parts.push(
      translate(
        'auto.components.sidebar.WorktreeLineageHiddenActivity.unread',
        '{{value0}} unread',
        {
          value0: unreadCount
        }
      )
    )
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

// Why: reuse the per-card status derivation so the chip reads exactly what the
// hidden cards would show.
export function selectLineageHiddenActivity(
  state: Parameters<typeof selectWorktreeActivityStatuses>[0],
  worktreeIds: readonly string[]
): LineageHiddenActivity {
  return summarizeLineageHiddenActivity(selectWorktreeActivityStatuses(state, worktreeIds).values())
}

// Why shallow: plain counts keep unrelated store ticks from re-rendering the chip.
export function useLineageHiddenActivity(worktreeIds: readonly string[]): LineageHiddenActivity {
  const selectActivity = useCallback(
    (state: AppState) => selectLineageHiddenActivity(state, worktreeIds),
    [worktreeIds]
  )
  return useAppStore(useShallow(selectActivity))
}
