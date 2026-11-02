import React from 'react'
import ColumnResizeHandle from '@/components/github-project/ColumnResizeHandle'
import { translate } from '@/i18n/i18n'
import type { AzureDevOpsBacklogColumnField } from '../../../../../shared/azure-devops/boards-types'
import { MIN_BACKLOG_COLUMN_WIDTH } from '@/components/task-page-azure-devops-backlog-columns'

export type AzureDevOpsBacklogHeaderProps = {
  columnFields: AzureDevOpsBacklogColumnField[]
  /** Streams pixel widths during a drag; omit to render a fixed header. */
  onResizeColumn?: (referenceName: string, width: number) => void
  onResizeEnd?: () => void
}

const HEADER_CELL_CLASS =
  'relative flex h-8 min-w-0 items-center border-b border-border/60 px-2 text-xs text-muted-foreground'

export function AzureDevOpsBacklogHeader(props: AzureDevOpsBacklogHeaderProps): React.JSX.Element {
  return (
    <div role="row" className="contents">
      <div role="columnheader" className={HEADER_CELL_CLASS}>
        {translate('auto.components.TaskPage.azureDevOps.columnOrder', 'Order')}
      </div>
      {props.columnFields.map((column) => (
        <div key={column.referenceName} role="columnheader" className={HEADER_CELL_CLASS}>
          <span className="min-w-0 truncate whitespace-nowrap" title={column.name}>
            {column.name}
          </span>
          {props.onResizeColumn ? (
            <ColumnResizeHandle
              mode="single"
              fieldId={column.referenceName}
              currentWidth={column.width}
              minWidth={MIN_BACKLOG_COLUMN_WIDTH}
              onResize={props.onResizeColumn}
              onResizeEnd={props.onResizeEnd}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
