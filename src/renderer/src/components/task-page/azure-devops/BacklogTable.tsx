import React from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../../../shared/azure-devops/boards-types'
import {
  BACKLOG_CELL_CLASS,
  ParentCell,
  StateCell,
  TagsCell,
  TextCell,
  TitleCell
} from './BacklogCells'
import {
  PARENT_FIELD,
  STATE_FIELD,
  TAGS_FIELD,
  TITLE_FIELD
} from '@/components/task-page-azure-devops-backlog-columns'
import { AzureDevOpsBacklogHeader } from './BacklogHeader'
import type { BacklogItemRow, BacklogRow } from '@/components/task-page-azure-devops-backlog-tree'

export { formatBacklogCell } from './BacklogCells'

export type AzureDevOpsBacklogTableProps = {
  rows: BacklogRow[]
  /** Effective columns with final widths (local overrides already applied). */
  columnFields: AzureDevOpsBacklogColumnField[]
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  tagColors: Record<string, string>
  /** Every item on the page (items, children, parents, ancestors) for the Parent column. */
  itemById: ReadonlyMap<number, AzureDevOpsWorkItem>
  onToggleExpand: (id: number) => void
  onOpenItem: (id: number) => void
  onUseItem: (id: number) => void
  onResizeColumn?: (referenceName: string, width: number) => void
  onResizeEnd?: () => void
}

const ORDER_COLUMN_WIDTH = 48

function gridTemplate(columnFields: AzureDevOpsBacklogColumnField[]): string {
  // Why: ADO widths are pixel hints; the title column absorbs leftover space so long titles stay readable.
  return [
    `${ORDER_COLUMN_WIDTH}px`,
    ...columnFields.map((c) =>
      c.referenceName === TITLE_FIELD ? `minmax(${c.width}px, 1fr)` : `${c.width}px`
    )
  ].join(' ')
}

function ItemRow({
  row,
  order,
  columnFields,
  workItemTypes,
  tagColors,
  itemById,
  onToggleExpand,
  onOpenItem,
  onUseItem
}: { row: BacklogItemRow; order: number | null } & Omit<
  AzureDevOpsBacklogTableProps,
  'rows' | 'onResizeColumn' | 'onResizeEnd'
>): React.JSX.Element {
  const { item } = row
  const metadata = workItemTypes[item.workItemType]
  return (
    <div role="row" className="group contents">
      <div
        role="gridcell"
        className={cn(BACKLOG_CELL_CLASS, 'justify-end text-xs tabular-nums text-muted-foreground')}
      >
        {order ?? ''}
      </div>
      {columnFields.map((column) => {
        const key = column.referenceName
        const cell =
          key === TITLE_FIELD ? (
            <TitleCell
              row={row}
              metadata={metadata}
              onToggleExpand={onToggleExpand}
              onOpenItem={onOpenItem}
              onUseItem={onUseItem}
            />
          ) : key === STATE_FIELD ? (
            <StateCell item={item} metadata={metadata} />
          ) : key === TAGS_FIELD ? (
            <TagsCell item={item} tagColors={tagColors} />
          ) : key === PARENT_FIELD ? (
            <ParentCell
              item={item}
              parent={item.parentId === null ? undefined : itemById.get(item.parentId)}
              workItemTypes={workItemTypes}
              onOpenItem={onOpenItem}
            />
          ) : (
            <TextCell referenceName={key} item={item} />
          )
        return <React.Fragment key={key}>{cell}</React.Fragment>
      })}
    </div>
  )
}

function GroupRow({ label, span }: { label: string; span: number }): React.JSX.Element {
  return (
    <div role="row" className="contents">
      <div role="gridcell" className={BACKLOG_CELL_CLASS} />
      <div
        role="gridcell"
        className={cn(BACKLOG_CELL_CLASS, 'gap-1 font-medium')}
        style={{ gridColumn: `2 / span ${span - 1}` }}
      >
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
    </div>
  )
}

export function AzureDevOpsBacklogTable(props: AzureDevOpsBacklogTableProps): React.JSX.Element {
  const template = gridTemplate(props.columnFields)
  const span = props.columnFields.length + 1
  let order = 0
  return (
    <div
      role="grid"
      className="grid w-max min-w-full text-[13px]"
      style={{ gridTemplateColumns: template }}
    >
      <AzureDevOpsBacklogHeader
        columnFields={props.columnFields}
        onResizeColumn={props.onResizeColumn}
        onResizeEnd={props.onResizeEnd}
      />
      {props.rows.map((row) => {
        if (row.kind === 'group') {
          return <GroupRow key={row.key} label={row.label} span={span} />
        }
        const rowOrder = row.kind === 'item' ? ++order : null
        return (
          <ItemRow
            key={row.key}
            row={row}
            order={rowOrder}
            columnFields={props.columnFields}
            workItemTypes={props.workItemTypes}
            tagColors={props.tagColors}
            itemById={props.itemById}
            onToggleExpand={props.onToggleExpand}
            onOpenItem={props.onOpenItem}
            onUseItem={props.onUseItem}
          />
        )
      })}
      {props.rows.length === 0 ? (
        <div
          className="py-8 text-center text-xs text-muted-foreground"
          style={{ gridColumn: `1 / span ${span}` }}
        >
          {translate('auto.components.TaskPage.azureDevOps.emptyBacklog', 'No work items match.')}
        </div>
      ) : null}
    </div>
  )
}
