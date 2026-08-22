import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import { LIST_TABLE_HEADER_CLASS } from '@/lib/list-table-layout'
import { AutomationListSortHeader } from './AutomationListSortHeader'
import type { AutomationListSort, AutomationListSortField } from './automation-list-view'

export function AutomationListTableHeader({
  sort,
  onSort
}: {
  sort: AutomationListSort | null
  onSort: (field: AutomationListSortField) => void
}): React.JSX.Element {
  return (
    <div className={cn(AUTOMATIONS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
      <AutomationListSortHeader
        field="name"
        label={translate('auto.components.automations.AutomationsPage.tableName', 'Name')}
        sort={sort}
        onSort={onSort}
      />
      <span>
        {translate('auto.components.automations.AutomationDetail.18763ded26', 'Schedule')}
      </span>
      <span>
        {translate('auto.components.automations.AutomationsPage.tableProject', 'Project')}
      </span>
      <span>
        {translate('auto.components.automations.AutomationDetail.578ff46987', 'Next run')}
      </span>
      <AutomationListSortHeader
        field="lastRun"
        label={translate('auto.components.automations.AutomationsPage.tableLastRun', 'Last run')}
        sort={sort}
        onSort={onSort}
      />
      <span>{translate('auto.components.automations.AutomationsPage.tableStatus', 'Status')}</span>
      <span className="text-center">
        {translate('auto.components.automations.AutomationDetail.2df8970cd5', 'Agent')}
      </span>
      <span className="sr-only">
        {translate('auto.components.automations.AutomationsPage.tableActions', 'Actions')}
      </span>
    </div>
  )
}
