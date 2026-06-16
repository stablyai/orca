import React from 'react'
import { SearchFilters, type SearchFiltersProps } from './SearchFilters'
import { SearchQueryRow, type SearchQueryRowProps } from './SearchQueryRow'

type SearchHeaderProps = SearchQueryRowProps & {
  embedded?: boolean
} & SearchFiltersProps

export function SearchHeader({
  includeInputRef,
  excludeInputRef,
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange,
  embedded = false,
  ...queryRowProps
}: SearchHeaderProps): React.JSX.Element {
  return (
    <div
      className={
        embedded ? 'flex flex-col gap-1.5' : 'flex flex-col gap-1.5 border-b border-border p-2'
      }
    >
      <SearchQueryRow {...queryRowProps} />
      {/* Why: the Search tab is a secondary destination — users switch to it
         when they want powerful, scoped search, so include/exclude fields
         stay visible instead of hidden behind a toggle. */}
      <SearchFilters
        includePattern={includePattern}
        excludePattern={excludePattern}
        includeInputRef={includeInputRef}
        excludeInputRef={excludeInputRef}
        onIncludeChange={onIncludeChange}
        onExcludeChange={onExcludeChange}
      />
    </div>
  )
}

export type { SearchQueryRowProps }
