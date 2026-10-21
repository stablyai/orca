import React from 'react'
import type { AutomationListRow } from './automation-list-row-identity'
import { AutomationListLocalRow, type AutomationListLocalRowProps } from './AutomationListLocalRow'

export type AutomationListLocalRowsProps = Omit<AutomationListLocalRowProps, 'row'> & {
  rows: readonly AutomationListRow[]
}

export function AutomationListLocalRows({
  rows,
  ...rowProps
}: AutomationListLocalRowsProps): React.JSX.Element {
  return (
    <>
      {rows.map((row) => (
        <AutomationListLocalRow key={row.key} row={row} {...rowProps} />
      ))}
    </>
  )
}
