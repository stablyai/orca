import React from 'react'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import type { AutomationListArrowKey } from './automation-list-keyboard-navigation'
import { clampAutomationListSearchQueryInput } from './automation-list-search-query'
import type { AutomationListFilter } from './automation-list-view'
import { AutomationListSearchField } from './AutomationListSearchField'
import { AutomationListFilterMenu } from './AutomationListFilterMenu'

type AutomationListToolbarProps = {
  listSearchQuery: string
  isListSearchQueryTooLarge: boolean
  onListSearchQueryChange: (query: string) => void
  onSearchArrowNavigate: (key: AutomationListArrowKey) => void
  onSearchEnter: () => void
  listFilter: AutomationListFilter
  onListFilterChange: (filter: AutomationListFilter) => void
  hostEntries: readonly AutomationHostCatalogEntry[]
}

export function AutomationListToolbar({
  listSearchQuery,
  isListSearchQueryTooLarge,
  onListSearchQueryChange,
  onSearchArrowNavigate,
  onSearchEnter,
  listFilter,
  onListFilterChange,
  hostEntries
}: AutomationListToolbarProps): React.JSX.Element {
  return (
    <>
      <AutomationListFilterMenu
        filter={listFilter}
        onChange={onListFilterChange}
        hostEntries={hostEntries}
      />
      <AutomationListSearchField
        query={listSearchQuery}
        isTooLarge={isListSearchQueryTooLarge}
        onQueryChange={(query) =>
          onListSearchQueryChange(clampAutomationListSearchQueryInput(query))
        }
        onClear={() => onListSearchQueryChange('')}
        onArrowNavigate={onSearchArrowNavigate}
        onEnter={onSearchEnter}
      />
    </>
  )
}
