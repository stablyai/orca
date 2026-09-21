import React from 'react'
import { translate } from '@/i18n/i18n'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import {
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_STICKY_HEADER_CELL_CLASS
} from '@/lib/list-table-layout'
import { AutomationListSortHeader } from './AutomationListSortHeader'
import type { AutomationListSort, AutomationListSortField } from './automation-list-view'

type HeaderColumn = {
  key: string
  fallback: string
  /** Absent for columns the list cannot order by. */
  sortField?: AutomationListSortField
}

const COLUMNS: readonly HeaderColumn[] = [
  {
    key: 'auto.components.automations.AutomationsPage.tableName',
    fallback: 'Name',
    sortField: 'name'
  },
  {
    key: 'auto.components.automations.AutomationDetail.18763ded26',
    fallback: 'Schedule'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableProject',
    fallback: 'Project'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableHost',
    fallback: 'Host'
  },
  {
    key: 'auto.components.automations.AutomationDetail.578ff46987',
    fallback: 'Next run'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableLastRun',
    fallback: 'Last run',
    sortField: 'lastRun'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableStatus',
    fallback: 'Status'
  },
  {
    key: 'auto.components.automations.AutomationDetail.2df8970cd5',
    fallback: 'Agent'
  }
]

export function AutomationListTableHeader({
  sort = null,
  onSort
}: {
  sort?: AutomationListSort | null
  onSort?: (field: AutomationListSortField) => void
} = {}): React.JSX.Element {
  return (
    <div className={`${AUTOMATIONS_TABLE_GRID_CLASS} ${LIST_TABLE_HEADER_CLASS}`}>
      {COLUMNS.map((column, index) => {
        const label = translate(column.key, column.fallback)
        const className =
          index === 0
            ? LIST_TABLE_STICKY_HEADER_CELL_CLASS
            : index === COLUMNS.length - 1
              ? 'text-center'
              : undefined
        return (
          <span key={column.key} className={className}>
            {column.sortField && onSort ? (
              <AutomationListSortHeader
                field={column.sortField}
                label={label}
                sort={sort}
                onSort={onSort}
              />
            ) : (
              label
            )}
          </span>
        )
      })}
      <span className="sr-only">
        {translate('auto.components.automations.AutomationsPage.tableActions', 'Actions')}
      </span>
    </div>
  )
}
