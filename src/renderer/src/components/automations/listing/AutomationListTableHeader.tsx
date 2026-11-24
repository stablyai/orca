import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { automationsTableGridClass } from './automations-table-layout'
import {
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_STICKY_HEADER_CELL_CLASS
} from '@/lib/list-interaction/list-table-layout'
import { AutomationListSortHeader } from './AutomationListSortHeader'
import type { AutomationListSort, AutomationListSortField } from './automation-list-view'

type HeaderColumn = {
  key: string
  fallback: string
  /** Absent for columns the list cannot order by. */
  sortField?: AutomationListSortField
  hostOnly?: boolean
}

const COLUMNS: readonly HeaderColumn[] = [
  {
    key: 'auto.components.automations.AutomationsPage.tableName',
    fallback: 'Name',
    sortField: 'name'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableProject',
    fallback: 'Project'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableHost',
    fallback: 'Host',
    hostOnly: true
  },
  {
    key: 'auto.components.automations.AutomationDetail.578ff46987',
    fallback: 'Next run'
  },
  {
    key: 'auto.components.automations.AutomationsPage.tableLastRun',
    fallback: 'Last run',
    sortField: 'lastRun'
  }
]

export function AutomationListTableHeader({
  sort = null,
  onSort,
  showHost = false
}: {
  sort?: AutomationListSort | null
  onSort?: (field: AutomationListSortField) => void
  showHost?: boolean
} = {}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={`${automationsTableGridClass(showHost)} ${LIST_TABLE_HEADER_CLASS}`}>
      {COLUMNS.filter((column) => showHost || !column.hostOnly).map((column, index) => {
        const label = t(column.key, column.fallback)
        return (
          <span
            key={column.key}
            className={index === 0 ? LIST_TABLE_STICKY_HEADER_CELL_CLASS : undefined}
          >
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
        {t('auto.components.automations.AutomationsPage.tableActions', 'Actions')}
      </span>
    </div>
  )
}
