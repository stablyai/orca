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
  width: string
  /** Always shown; not offered in the column picker. */
  locked?: boolean
  defaultVisible: boolean
}

export const JIRA_LIST_COLUMNS: readonly JiraListColumn[] = [
  { id: 'key', width: '96px', locked: true, defaultVisible: true },
  // Why: optional columns shrink to their floor and the title keeps its own, so enabling every
  // column narrows the list instead of collapsing the title or clipping the last column.
  { id: 'title', width: 'minmax(180px,1.5fr)', locked: true, defaultVisible: true },
  { id: 'status', width: 'minmax(88px,120px)', defaultVisible: true },
  { id: 'priority', width: 'minmax(72px,88px)', defaultVisible: true },
  { id: 'assignee', width: 'minmax(100px,128px)', defaultVisible: true },
  { id: 'parent', width: 'minmax(110px,150px)', defaultVisible: false },
  { id: 'sprint', width: 'minmax(80px,110px)', defaultVisible: false },
  { id: 'storyPoints', width: 'minmax(48px,60px)', defaultVisible: false },
  { id: 'originalEstimate', width: 'minmax(60px,76px)', defaultVisible: false },
  { id: 'remainingEstimate', width: 'minmax(64px,80px)', defaultVisible: false },
  { id: 'updated', width: 'minmax(72px,92px)', defaultVisible: true }
]

const ACTIONS_COLUMN_WIDTH = '64px'

// Why: column layout is a per-device view preference, kept out of the strict
// `ui.set` schema for the same reason as the Linear issue view (see linear-issue-view-storage.ts).
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
      return translate('auto.components.TaskPage.jiraColumnParent', 'Epic / Parent')
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
  const known = new Set(JIRA_LIST_COLUMNS.map((c) => c.id))
  const ids = new Set(raw.filter((id): id is JiraListColumnId => known.has(id)))
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

export function jiraListGridTemplate(columns: readonly JiraListColumn[]): string {
  return [...columns.map((column) => column.width), ACTIONS_COLUMN_WIDTH].join(' ')
}

// Jira's default working time: 8h per day, 5d per week.
const HOUR = 3600
const DAY = 8 * HOUR
const WEEK = 5 * DAY

export function formatJiraEstimate(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) {
    return '–'
  }
  const parts: string[] = []
  let rest = Math.round(seconds)
  for (const [unit, size] of [
    ['w', WEEK],
    ['d', DAY],
    ['h', HOUR],
    ['m', 60]
  ] as const) {
    const count = Math.floor(rest / size)
    if (count > 0) {
      parts.push(`${count}${unit}`)
      rest -= count * size
    }
  }
  // Two units keep the column narrow: "1w 2d 3h" reads as "1w 2d".
  return parts.slice(0, 2).join(' ') || '<1m'
}

export function formatJiraStoryPoints(points: number | undefined): string {
  return points === undefined ? '–' : String(Math.round(points * 10) / 10)
}
