import type { CSSProperties } from 'react'
import { translate } from '@/i18n/i18n'

export type JiraListColumnId =
  | 'key'
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'parent'
  | 'sprint'
  | 'storyPoints'
  | 'originalEstimate'
  | 'remainingEstimate'
  | 'updated'

export type JiraListColumn = {
  id: JiraListColumnId
  widths: readonly [number, number, number]
  /** Always shown; not offered in the column picker. */
  locked?: boolean
  defaultVisible: boolean
}

export const JIRA_LIST_COLUMNS: readonly JiraListColumn[] = [
  { id: 'key', widths: [90, 96, 104], locked: true, defaultVisible: true },
  { id: 'title', widths: [180, 180, 180], locked: true, defaultVisible: true },
  { id: 'status', widths: [128, 132, 144], defaultVisible: true },
  { id: 'priority', widths: [92, 120, 132], defaultVisible: true },
  { id: 'assignee', widths: [0, 136, 160], defaultVisible: true },
  { id: 'parent', widths: [150, 150, 150], defaultVisible: false },
  { id: 'sprint', widths: [110, 110, 110], defaultVisible: false },
  { id: 'storyPoints', widths: [60, 60, 60], defaultVisible: false },
  { id: 'originalEstimate', widths: [88, 88, 88], defaultVisible: false },
  { id: 'remainingEstimate', widths: [88, 88, 88], defaultVisible: false },
  { id: 'updated', widths: [80, 96, 128], defaultVisible: true }
]

// Device-local, like Linear display preferences, rather than synced through ui.set.
const STORAGE_KEY = 'orca.jira.list-columns.v1'

export function getJiraListColumnLabel(id: JiraListColumnId): string {
  switch (id) {
    case 'key':
      return translate('auto.components.TaskPage.37e7ee311e', 'Key')
    case 'title':
      return translate('auto.components.TaskPage.b1eaa18ace', 'Issue')
    case 'status':
      return translate('auto.components.TaskPage.154b0fa623', 'Status')
    case 'priority':
      return translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')
    case 'assignee':
      return translate('auto.components.TaskPage.d2a876ca53', 'Assignee')
    case 'parent':
      return translate('auto.components.TaskPage.jiraColumnParent', 'Parent')
    case 'sprint':
      return translate('auto.components.TaskPage.jiraColumnSprint', 'Sprint')
    case 'storyPoints':
      return translate('auto.components.TaskPage.jiraColumnStoryPoints', 'Points')
    case 'originalEstimate':
      return translate('auto.components.TaskPage.jiraColumnOriginalEstimate', 'Estimate')
    case 'remainingEstimate':
      return translate('auto.components.TaskPage.jiraColumnRemainingEstimate', 'Remaining')
    case 'updated':
      return translate('auto.components.TaskPage.f362667d55', 'Updated')
  }
}

export function defaultJiraListColumnIds(): Set<JiraListColumnId> {
  return new Set(JIRA_LIST_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id))
}

export function resolveJiraListColumnIds(raw: unknown): Set<JiraListColumnId> {
  if (!Array.isArray(raw)) {
    return defaultJiraListColumnIds()
  }
  const ids = new Set(
    raw.filter(
      (id): id is JiraListColumnId =>
        typeof id === 'string' && JIRA_LIST_COLUMNS.some((column) => column.id === id)
    )
  )
  for (const column of JIRA_LIST_COLUMNS) {
    if (column.locked) {
      ids.add(column.id)
    }
  }
  return ids
}

export function loadJiraListColumnIds(): Set<JiraListColumnId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return resolveJiraListColumnIds(raw ? JSON.parse(raw) : undefined)
  } catch {
    return defaultJiraListColumnIds()
  }
}

export function saveJiraListColumnIds(ids: ReadonlySet<JiraListColumnId>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // The live view stays usable when browser storage is unavailable or full.
  }
}

export function visibleJiraListColumns(ids: ReadonlySet<JiraListColumnId>): JiraListColumn[] {
  return JIRA_LIST_COLUMNS.filter((column) => ids.has(column.id))
}

export function jiraListGridTemplate(
  columns: readonly JiraListColumn[],
  tier: 0 | 1 | 2 = 1
): string {
  return [
    ...columns
      .filter((column) => column.widths[tier] > 0)
      .map((column) => (column.id === 'title' ? 'minmax(180px,1fr)' : `${column.widths[tier]}px`)),
    '104px'
  ].join(' ')
}

type JiraGridStyle = CSSProperties & {
  '--jira-cols-md': string
  '--jira-cols-lg': string
  '--jira-cols-xl': string
  '--jira-min-md': string
  '--jira-min-lg': string
  '--jira-min-xl': string
}

function jiraListMinimumWidth(columns: readonly JiraListColumn[], tier: 0 | 1 | 2): string {
  const shown = columns.filter((column) => column.widths[tier] > 0)
  const tracks = shown.reduce((sum, column) => sum + column.widths[tier], 104)
  return `${tracks + shown.length * 12 + 24}px`
}

export function jiraListGridStyle(columns: readonly JiraListColumn[]): JiraGridStyle {
  return {
    '--jira-cols-md': jiraListGridTemplate(columns, 0),
    '--jira-cols-lg': jiraListGridTemplate(columns, 1),
    '--jira-cols-xl': jiraListGridTemplate(columns, 2),
    '--jira-min-md': jiraListMinimumWidth(columns, 0),
    '--jira-min-lg': jiraListMinimumWidth(columns, 1),
    '--jira-min-xl': jiraListMinimumWidth(columns, 2)
  }
}

export function jiraListColumnVisibility(column: JiraListColumnId): string | undefined {
  return column === 'assignee' ? '@max-5xl:!hidden' : undefined
}

export function fallbackJiraSortColumn(ids: ReadonlySet<JiraListColumnId>): JiraListColumnId {
  return ids.has('updated') ? 'updated' : 'key'
}

// Hours do not depend on the site's configurable working day/week length.
export function formatJiraEstimate(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '–'
  }
  if (seconds === 0) {
    return '0m'
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : ''].filter(Boolean).join(' ') || '<1m'
}

export function formatJiraStoryPoints(points: number | undefined): string {
  return points === undefined ? '–' : String(points)
}
