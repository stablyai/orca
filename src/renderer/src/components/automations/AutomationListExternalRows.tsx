import React from 'react'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  AutomationListExternalRow,
  type AutomationListExternalRowProps
} from './AutomationListExternalRow'

export type AutomationListExternalRowsProps = Omit<AutomationListExternalRowProps, 'entry'> & {
  entries: readonly ExternalAutomationListEntry[]
}

export function AutomationListExternalRows({
  entries,
  ...rowProps
}: AutomationListExternalRowsProps): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => (
        <AutomationListExternalRow key={entry.key} entry={entry} {...rowProps} />
      ))}
    </>
  )
}
