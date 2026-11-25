import { translate } from '@/i18n/i18n'
import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogViewSettings
} from '../../../shared/azure-devops/boards-types'

export const TITLE_FIELD = 'System.Title'
export const STATE_FIELD = 'System.State'
export const PARENT_FIELD = 'System.Parent'
export const TAGS_FIELD = 'System.Tags'
const WORK_ITEM_TYPE_FIELD = 'System.WorkItemType'

export const MIN_BACKLOG_COLUMN_WIDTH = 60
export const DEFAULT_TITLE_WIDTH = 400
const DEFAULT_STATE_WIDTH = 100

function builtInColumns(): AzureDevOpsBacklogColumnField[] {
  return [
    {
      referenceName: TITLE_FIELD,
      name: translate('auto.components.TaskPage.azureDevOps.columnTitle', 'Title'),
      width: DEFAULT_TITLE_WIDTH
    },
    {
      referenceName: STATE_FIELD,
      name: translate('auto.components.TaskPage.azureDevOps.columnState', 'State'),
      width: DEFAULT_STATE_WIDTH
    }
  ]
}

/**
 * Column source, in order: the user's own column options for the level, the
 * process `columnFields`, the built-in minimum. The type is never a text column
 * (its icon leads the title, as in ADO) and Title is always present.
 */
export function resolveAzureDevOpsBacklogColumns(
  level: AzureDevOpsBacklogLevel | null,
  viewSettings: AzureDevOpsBacklogViewSettings | null | undefined
): AzureDevOpsBacklogColumnField[] {
  const user = level ? viewSettings?.columnOptionsByLevel[level.id] : undefined
  const source =
    user && user.length > 0
      ? user
      : level && level.columnFields.length > 0
        ? level.columnFields
        : builtInColumns()
  const seen = new Set<string>()
  const columns = source.filter((column) => {
    if (column.referenceName === WORK_ITEM_TYPE_FIELD || seen.has(column.referenceName)) {
      return false
    }
    seen.add(column.referenceName)
    return true
  })
  if (!seen.has(TITLE_FIELD)) {
    columns.unshift(builtInColumns()[0])
  }
  return columns
}

/** Local overrides win over the ADO width; every width is clamped to the resize minimum. */
export function applyAzureDevOpsColumnWidths(
  columns: AzureDevOpsBacklogColumnField[],
  overrides: Readonly<Record<string, number>>
): AzureDevOpsBacklogColumnField[] {
  return columns.map((column) => {
    const override = overrides[column.referenceName]
    const width =
      typeof override === 'number' && Number.isFinite(override) ? override : column.width
    return { ...column, width: Math.max(MIN_BACKLOG_COLUMN_WIDTH, Math.round(width)) }
  })
}

/** Settings key for persisted width overrides: one entry per (project, team, level). */
export function azureDevOpsColumnWidthKey(
  repo: { organization: string | null; project: string },
  teamName: string,
  levelId: string
): string {
  return `${repo.organization ?? ''}/${repo.project}::${teamName}::${levelId}`
}
