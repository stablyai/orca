import React from 'react'
import { translate } from '@/i18n/i18n'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import {
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_STICKY_HEADER_CELL_CLASS
} from '@/lib/list-table-layout'

export function AutomationListTableHeader(): React.JSX.Element {
  const labels = [
    ['auto.components.automations.AutomationsPage.tableName', 'Name'],
    ['auto.components.automations.AutomationDetail.18763ded26', 'Schedule'],
    ['auto.components.automations.AutomationsPage.tableProject', 'Project'],
    ['auto.components.automations.AutomationsPage.tableHost', 'Host'],
    ['auto.components.automations.AutomationDetail.578ff46987', 'Next run'],
    ['auto.components.automations.AutomationsPage.tableLastRun', 'Last run'],
    ['auto.components.automations.AutomationsPage.tableStatus', 'Status'],
    ['auto.components.automations.AutomationDetail.2df8970cd5', 'Agent']
  ] as const
  return (
    <div className={`${AUTOMATIONS_TABLE_GRID_CLASS} ${LIST_TABLE_HEADER_CLASS}`}>
      {labels.map(([key, fallback], index) => (
        <span
          key={key}
          className={
            index === 0
              ? LIST_TABLE_STICKY_HEADER_CELL_CLASS
              : index === labels.length - 1
                ? 'text-center'
                : undefined
          }
        >
          {translate(key, fallback)}
        </span>
      ))}
      <span className="sr-only">
        {translate('auto.components.automations.AutomationsPage.tableActions', 'Actions')}
      </span>
    </div>
  )
}
