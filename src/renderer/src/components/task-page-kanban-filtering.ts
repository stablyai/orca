import type { KanbanTaskFilter, KanbanTaskSummary } from '../../../shared/kanban-types'

export const KANBAN_DONE_LANE_NAME = 'Сделано'

// Why: the first paint must never show all accessible tasks — the default
// filter restricts to the viewer's executor role and hides the done lane.
export function createDefaultKanbanTaskFilter(): KanbanTaskFilter {
  return { role: 'executor' }
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function matchesDue(
  due: string | null,
  kind: NonNullable<KanbanTaskFilter['due']>,
  todayMs: number
): boolean {
  if (kind === 'none') {
    return due === null
  }
  if (!due) {
    return false
  }
  const dueKey = due.slice(0, 10)
  const todayKey = dayKey(todayMs)
  if (kind === 'overdue') {
    return dueKey < todayKey
  }
  if (kind === 'today') {
    return dueKey === todayKey
  }
  const weekEndKey = dayKey(todayMs + 7 * 86_400_000)
  return dueKey > todayKey && dueKey <= weekEndKey
}

function isViewerInRole(
  task: KanbanTaskSummary,
  viewerId: string,
  role: KanbanTaskFilter['role']
): boolean {
  if (role === 'executor') {
    return task.executors.some((person) => person.id === viewerId)
  }
  if (role === 'observer') {
    return task.observers.some((person) => person.id === viewerId)
  }
  return task.createdBy?.id === viewerId
}

export function filterKanbanTasks({
  tasks,
  viewerId,
  filter,
  now = Date.now
}: {
  tasks: readonly KanbanTaskSummary[]
  viewerId: string
  filter: KanbanTaskFilter
  now?: () => number
}): KanbanTaskSummary[] {
  const includeDone = filter.includeDone ?? false
  const query = filter.query?.trim().toLowerCase() ?? ''
  return tasks.filter((task) => {
    if (!isViewerInRole(task, viewerId, filter.role)) {
      return false
    }
    if (!includeDone && task.laneName === KANBAN_DONE_LANE_NAME) {
      return false
    }
    if (filter.laneId && task.laneId !== filter.laneId) {
      return false
    }
    if (filter.urgent && !task.urgent) {
      return false
    }
    if (filter.due && !matchesDue(task.due, filter.due, now())) {
      return false
    }
    if (
      query &&
      !task.title.toLowerCase().includes(query) &&
      !task.id.toLowerCase().includes(query)
    ) {
      return false
    }
    return true
  })
}

// Why: deterministic ordering — urgent first, then earliest due, then no due,
// then a locale-aware title comparison so ties never rely on insertion order.
export function sortKanbanTasks(tasks: readonly KanbanTaskSummary[]): KanbanTaskSummary[] {
  return [...tasks].sort((a, b) => {
    if (a.urgent !== b.urgent) {
      return a.urgent ? -1 : 1
    }
    const aDue = a.due ? Date.parse(a.due) : null
    const bDue = b.due ? Date.parse(b.due) : null
    if (aDue !== null && bDue === null) {
      return -1
    }
    if (aDue === null && bDue !== null) {
      return 1
    }
    if (aDue !== null && bDue !== null && aDue !== bDue) {
      return aDue - bDue
    }
    return a.title.localeCompare(b.title)
  })
}

export function applyKanbanTaskFilterAndSort({
  tasks,
  viewerId,
  filter,
  now
}: {
  tasks: readonly KanbanTaskSummary[]
  viewerId: string
  filter: KanbanTaskFilter
  now?: () => number
}): KanbanTaskSummary[] {
  return sortKanbanTasks(filterKanbanTasks({ tasks, viewerId, filter, now }))
}
