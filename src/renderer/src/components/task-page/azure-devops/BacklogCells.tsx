import React from 'react'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../../../shared/azure-devops/boards-types'
import type { BacklogItemRow } from '@/components/task-page-azure-devops-backlog-tree'
import { WorkItemStateDot, WorkItemTagChip, WorkItemTypeIcon } from './WorkItemVisuals'

const DATE_FIELD = /Date$/
/** Indent per tree depth; ADO uses ~20px per level. */
export const BACKLOG_INDENT_PX = 20
// Why: `display: contents` rows have no box of their own, so hover paints per cell.
export const BACKLOG_CELL_CLASS =
  'flex h-9 min-w-0 items-center px-2 text-[13px] group-hover:bg-accent'

export function formatBacklogCell(referenceName: string, value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  // Why: a work item number is an identifier, so it never takes the locale's grouping separator.
  if (referenceName === 'System.Id') {
    return String(value)
  }
  if (typeof value === 'object') {
    return 'displayName' in value && typeof value.displayName === 'string' ? value.displayName : ''
  }
  if (typeof value === 'string' && DATE_FIELD.test(referenceName)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(getIntlLocale())
  }
  if (typeof value === 'number') {
    return value.toLocaleString(getIntlLocale())
  }
  return String(value)
}

export function TitleCell({
  row,
  metadata,
  onToggleExpand,
  onOpenItem,
  onUseItem
}: {
  row: BacklogItemRow
  metadata: AzureDevOpsWorkItemTypeMetadata | undefined
  onToggleExpand: (id: number) => void
  onOpenItem: (id: number) => void
  onUseItem: (id: number) => void
}): React.JSX.Element {
  const { item } = row
  return (
    <div
      role="gridcell"
      className={cn(BACKLOG_CELL_CLASS, 'gap-1')}
      style={{ paddingLeft: 8 + row.depth * BACKLOG_INDENT_PX }}
    >
      {row.hasChildren ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0"
          aria-label={
            row.expanded
              ? translate('auto.components.TaskPage.azureDevOps.collapse', 'Collapse')
              : translate('auto.components.TaskPage.azureDevOps.expand', 'Expand')
          }
          onClick={() => onToggleExpand(item.id)}
        >
          {row.expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </Button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <span className="inline-flex shrink-0" style={{ color: metadata?.color ?? undefined }}>
        <WorkItemTypeIcon metadata={metadata} className="size-4" />
      </span>
      <button
        type="button"
        className="min-w-0 truncate text-left hover:underline"
        title={item.title}
        onClick={() => onOpenItem(item.id)}
      >
        {item.title}
      </button>
      {/* Why: the reveal lives on a wrapper because the Button primitive owns its own effects. */}
      <span className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="ghost" size="xs" onClick={() => onUseItem(item.id)}>
          <Play className="size-3" />
          {translate('auto.components.TaskPage.azureDevOps.useItem', 'Use')}
        </Button>
      </span>
    </div>
  )
}

export function StateCell({
  item,
  metadata
}: {
  item: AzureDevOpsWorkItem
  metadata: AzureDevOpsWorkItemTypeMetadata | undefined
}): React.JSX.Element {
  return (
    <div role="gridcell" className={BACKLOG_CELL_CLASS}>
      <WorkItemStateDot state={item.state} metadata={metadata} className="min-w-0 truncate" />
    </div>
  )
}

export function TagsCell({
  item,
  tagColors
}: {
  item: AzureDevOpsWorkItem
  tagColors: Record<string, string>
}): React.JSX.Element {
  return (
    <div role="gridcell" className={cn(BACKLOG_CELL_CLASS, 'gap-1 overflow-hidden')}>
      {item.tags.map((tag) => (
        <WorkItemTagChip key={tag} tag={tag} color={tagColors[tag] ?? null} />
      ))}
    </div>
  )
}

/** Parent type icon + title, as ADO's Parent column; falls back to the id when it was not hydrated. */
export function ParentCell({
  item,
  parent,
  workItemTypes,
  onOpenItem
}: {
  item: AzureDevOpsWorkItem
  parent: AzureDevOpsWorkItem | undefined
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  onOpenItem: (id: number) => void
}): React.JSX.Element {
  if (item.parentId === null) {
    return <div role="gridcell" className={BACKLOG_CELL_CLASS} />
  }
  if (!parent) {
    return (
      <div role="gridcell" className={cn(BACKLOG_CELL_CLASS, 'text-muted-foreground')}>
        #{item.parentId}
      </div>
    )
  }
  const metadata = workItemTypes[parent.workItemType]
  return (
    <div role="gridcell" className={cn(BACKLOG_CELL_CLASS, 'gap-1')}>
      <span className="inline-flex shrink-0" style={{ color: metadata?.color ?? undefined }}>
        <WorkItemTypeIcon metadata={metadata} className="size-3.5" />
      </span>
      <button
        type="button"
        className="min-w-0 truncate text-left hover:underline"
        title={parent.title}
        onClick={() => onOpenItem(parent.id)}
      >
        {parent.title}
      </button>
    </div>
  )
}

export function TextCell({
  referenceName,
  item
}: {
  referenceName: string
  item: AzureDevOpsWorkItem
}): React.JSX.Element {
  const text = formatBacklogCell(referenceName, item.fields[referenceName])
  return (
    <div role="gridcell" className={cn(BACKLOG_CELL_CLASS, 'text-muted-foreground')}>
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </div>
  )
}
