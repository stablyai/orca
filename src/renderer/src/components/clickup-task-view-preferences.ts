// Device-local, like the Jira list columns, rather than synced through ui.set:
// which Space or Sprint someone browses is a per-machine habit.
const STORAGE_KEY = 'orca.clickup.task-view.v1'

export type ClickUpTaskViewMode = 'list' | 'gantt'
export type ClickUpGanttZoom = 'day' | 'week'
export type ClickUpGanttGroupBy = 'list' | 'status'
// 'current' follows the dated Sprint covering today; 'all' disables the filter.
export type ClickUpSprintSelection = 'current' | 'all' | { listId: string }

export type ClickUpTaskViewPreferences = {
  spaceByWorkspace: Record<string, string>
  statusesBySpace: Record<string, string[]>
  sprintBySpace: Record<string, ClickUpSprintSelection>
  // The sprint Folder whose Sprints the picker lists; unset uses the newest active one.
  sprintFolderBySpace: Record<string, string>
  view: ClickUpTaskViewMode
  ganttZoom: ClickUpGanttZoom
  ganttGroupBy: ClickUpGanttGroupBy
}

export const DEFAULT_CLICKUP_TASK_VIEW_PREFERENCES: ClickUpTaskViewPreferences = {
  spaceByWorkspace: {},
  statusesBySpace: {},
  sprintBySpace: {},
  sprintFolderBySpace: {},
  view: 'list',
  ganttZoom: 'day',
  ganttGroupBy: 'list'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function stringListMap(value: unknown): Record<string, string[]> {
  if (!isPlainRecord(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, items]) =>
      Array.isArray(items)
        ? [[key, items.filter((item): item is string => typeof item === 'string')]]
        : []
    )
  )
}

function sprintSelection(value: unknown): ClickUpSprintSelection | null {
  if (value === 'current' || value === 'all') {
    return value
  }
  return isPlainRecord(value) && typeof value.listId === 'string' ? { listId: value.listId } : null
}

// Accepts anything read from storage; unknown or corrupt fields fall back to defaults.
export function resolveClickUpTaskViewPreferences(value: unknown): ClickUpTaskViewPreferences {
  if (!isPlainRecord(value)) {
    return DEFAULT_CLICKUP_TASK_VIEW_PREFERENCES
  }
  const sprintBySpace: Record<string, ClickUpSprintSelection> = {}
  if (isPlainRecord(value.sprintBySpace)) {
    for (const [spaceId, selection] of Object.entries(value.sprintBySpace)) {
      const resolved = sprintSelection(selection)
      if (resolved) {
        sprintBySpace[spaceId] = resolved
      }
    }
  }
  return {
    spaceByWorkspace: stringMap(value.spaceByWorkspace),
    statusesBySpace: stringListMap(value.statusesBySpace),
    sprintBySpace,
    sprintFolderBySpace: stringMap(value.sprintFolderBySpace),
    view: value.view === 'gantt' ? 'gantt' : 'list',
    ganttZoom: value.ganttZoom === 'week' ? 'week' : 'day',
    ganttGroupBy: value.ganttGroupBy === 'status' ? 'status' : 'list'
  }
}

export function loadClickUpTaskViewPreferences(): ClickUpTaskViewPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return resolveClickUpTaskViewPreferences(raw ? JSON.parse(raw) : undefined)
  } catch {
    return DEFAULT_CLICKUP_TASK_VIEW_PREFERENCES
  }
}

export function saveClickUpTaskViewPreferences(preferences: ClickUpTaskViewPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // The live view stays usable when browser storage is unavailable or full.
  }
}
