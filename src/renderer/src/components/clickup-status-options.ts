import type { ClickUpList, ClickUpSpace, ClickUpStatus } from '../../../shared/clickup-types'

// Status types that mean "finished" in ClickUp: 'closed' is the Closed group,
// 'done' the Done group (e.g. "on prod env"). The default view hides both.
const FINISHED_STATUS_TYPES = new Set(['closed', 'done'])

export function isFinishedClickUpStatus(status: Pick<ClickUpStatus, 'type'>): boolean {
  return FINISHED_STATUS_TYPES.has(status.type)
}

// Every status a task in the Space can have: the Space workflow plus List
// overrides, deduped by name (ClickUp matches statuses[] case-insensitively).
export function collectClickUpStatusOptions(
  space: ClickUpSpace | null,
  lists: readonly ClickUpList[]
): ClickUpStatus[] {
  const byName = new Map<string, ClickUpStatus>()
  for (const status of [...(space?.statuses ?? []), ...lists.flatMap((list) => list.statuses)]) {
    const key = status.name.toLocaleLowerCase()
    if (!byName.has(key)) {
      byName.set(key, status)
    }
  }
  const groupOrder = (status: ClickUpStatus): number =>
    status.type === 'open' ? 0 : status.type === 'closed' ? 3 : status.type === 'done' ? 2 : 1
  return [...byName.values()].sort(
    (a, b) => groupOrder(a) - groupOrder(b) || a.orderIndex - b.orderIndex
  )
}

export function defaultClickUpStatusSelection(options: readonly ClickUpStatus[]): string[] {
  return options.filter((status) => !isFinishedClickUpStatus(status)).map((status) => status.name)
}

// The persisted selection, minus statuses the Space no longer has; falls back
// to the open statuses when nothing valid remains.
export function resolveClickUpStatusSelection(
  options: readonly ClickUpStatus[],
  saved: readonly string[] | undefined
): string[] {
  if (saved === undefined) {
    return defaultClickUpStatusSelection(options)
  }
  const known = new Set(options.map((status) => status.name.toLocaleLowerCase()))
  const valid = saved.filter((name) => known.has(name.toLocaleLowerCase()))
  return valid.length > 0 || saved.length === 0 ? valid : defaultClickUpStatusSelection(options)
}
