export type ActivityThreadVirtualGroup<TThread> = {
  key: string
  label: string
  threads: TThread[]
}

export type ActivityThreadVirtualRow<TGroup, TThread> =
  | {
      kind: 'group'
      key: string
      groupKey: string
      group: TGroup
    }
  | {
      kind: 'thread'
      key: string
      groupKey: string
      thread: TThread
    }

// Why: these estimates intentionally mirror the Activity row CSS and skew
// slightly high; TanStack corrects with measured elements, while underestimates
// are more likely to expose blank space during fast first-pass scrolling.
export const ACTIVITY_THREAD_GROUP_ROW_ESTIMATE_PX = 30
export const ACTIVITY_THREAD_COMPACT_ROW_ESTIMATE_PX = 66
export const ACTIVITY_THREAD_REGULAR_ROW_ESTIMATE_PX = 112
export const ACTIVITY_THREAD_VIRTUALIZER_OVERSCAN = 12

export function buildActivityThreadVirtualRows<
  TThread,
  TGroup extends ActivityThreadVirtualGroup<TThread> = ActivityThreadVirtualGroup<TThread>
>(
  groups: TGroup[],
  getThreadKey: (thread: TThread) => string
): ActivityThreadVirtualRow<TGroup, TThread>[] {
  const rows: ActivityThreadVirtualRow<TGroup, TThread>[] = []
  for (const group of groups) {
    rows.push({
      kind: 'group',
      key: `group:${group.key}`,
      groupKey: group.key,
      group
    })
    for (const thread of group.threads) {
      rows.push({
        kind: 'thread',
        key: `thread:${getThreadKey(thread)}`,
        groupKey: group.key,
        thread
      })
    }
  }
  return rows
}

export function getActivityThreadStickyIndexes<TGroup, TThread>(
  rows: ActivityThreadVirtualRow<TGroup, TThread>[]
): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    if (row.kind === 'group') {
      indexes.push(index)
    }
  })
  return indexes
}

export function getActiveActivityThreadStickyIndex(
  stickyIndexes: readonly number[],
  startIndex: number
): number | null {
  for (let index = stickyIndexes.length - 1; index >= 0; index -= 1) {
    const stickyIndex = stickyIndexes[index]
    if (stickyIndex <= startIndex) {
      return stickyIndex
    }
  }
  return stickyIndexes[0] ?? null
}

export function estimateActivityThreadVirtualRowSize<TGroup, TThread>(
  row: ActivityThreadVirtualRow<TGroup, TThread> | undefined,
  compactMode: boolean
): number {
  if (!row || row.kind === 'group') {
    return ACTIVITY_THREAD_GROUP_ROW_ESTIMATE_PX
  }
  return compactMode
    ? ACTIVITY_THREAD_COMPACT_ROW_ESTIMATE_PX
    : ACTIVITY_THREAD_REGULAR_ROW_ESTIMATE_PX
}
