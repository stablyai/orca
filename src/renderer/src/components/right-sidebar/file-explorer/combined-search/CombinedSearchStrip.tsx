import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React, { useState } from 'react'
import { CaseSensitive, ListFilter, Loader2, Regex, Search, WholeWord, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { ToggleButton } from '../content-search/SearchResultItems'
import {
  countActiveSearchFilters,
  SearchFilters,
  type SearchFiltersProps
} from '../content-search/SearchFilters'
import { COMBINED_SEARCH_LISTBOX_ID } from './combined-search-rows'
import type { CombinedSearchFieldState } from './combined-search-types'

export function CombinedSearchStrip({
  inputRef,
  field,
  filters,
  scopeLabel
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  field: CombinedSearchFieldState
  filters: SearchFiltersProps
  scopeLabel?: string
}): React.JSX.Element {
  const t = useTranslate()
  const [focused, setFocused] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Text-match options stay out of the way until the user is searching.
  const showOptions = focused || field.query.length > 0
  const activeFilterCount = countActiveSearchFilters(filters)
  const filterSummary = [
    filters.includePattern.trim(),
    filters.excludePattern.trim() && `!${filters.excludePattern.trim()}`
  ]
    .filter(Boolean)
    .join(', ')
  // A set filter stays visible at rest so it never silently narrows text results.
  const showToolbar = showOptions || filtersOpen || activeFilterCount > 0
  const hasQuery = field.query.trim().length > 0
  const searchLabel = t('fileExplorer.combinedSearch.placeholder', 'Search')

  return (
    <div
      className="border-b border-border px-2 py-2"
      data-ignore-file-explorer-keys="true"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          setFocused(false)
        }
      }}
    >
      <div
        className="flex h-8 items-center gap-1 rounded-md border border-border bg-input/50 px-[7px] focus-within:border-ring focus-within:ring-1 focus-within:ring-ring"
        data-combined-search-field=""
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <ImeInput
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={hasQuery}
          aria-controls={hasQuery ? COMBINED_SEARCH_LISTBOX_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={field.activeDescendantId}
          aria-label={searchLabel}
          data-file-search-input="true"
          data-explorer-query-input="files"
          className="min-w-0 flex-1 bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={
            scopeLabel
              ? t('fileExplorer.combinedSearch.placeholderScoped', 'Search {{path}}', {
                  path: scopeLabel
                })
              : searchLabel
          }
          value={field.query}
          onChange={(event) => field.onQueryChange(event.currentTarget.value)}
          onKeyDown={field.onKeyDown}
          spellCheck={false}
        />
        {field.loading ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        {field.query ? (
          <span className="flex shrink-0" onMouseDown={(event) => event.preventDefault()}>
            <ToggleButton
              onClick={field.onClear}
              title={t('auto.components.right.sidebar.SearchQueryRow.clearLabel', 'Clear search')}
            >
              <X className="size-3" />
            </ToggleButton>
          </span>
        ) : null}
      </div>
      {showToolbar ? (
        // Why: options live under the field so a 220px field still shows the query.
        <div
          className="flex h-7 items-center gap-0.5 pt-1"
          data-search-options=""
          onMouseDown={(event) => event.preventDefault()}
        >
          <ToggleButton
            active={field.caseSensitive}
            onClick={field.onToggleCaseSensitive}
            title={t('auto.components.right.sidebar.SearchHeader.464ae3974f', 'Match Case')}
          >
            <CaseSensitive className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            active={field.wholeWord}
            onClick={field.onToggleWholeWord}
            title={t('auto.components.right.sidebar.SearchHeader.4567e6e0b6', 'Match Whole Word')}
          >
            <WholeWord className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            active={field.useRegex}
            onClick={field.onToggleRegex}
            title={t(
              'auto.components.right.sidebar.SearchHeader.6234a5ef85',
              'Use Regular Expression'
            )}
          >
            <Regex className="size-3.5" />
          </ToggleButton>
          <span className="flex-1" />
          {filterSummary ? (
            <span
              className="min-w-0 max-w-[60%] truncate rounded-sm bg-muted px-1.5 text-2xs text-muted-foreground"
              title={filterSummary}
              data-search-filter-chip=""
            >
              {filterSummary}
            </span>
          ) : null}
          <ToggleButton
            active={filtersOpen || activeFilterCount > 0}
            ariaExpanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
            title={t('fileSearch.filters.toggle', 'Toggle search details')}
          >
            <ListFilter className="size-3.5" />
          </ToggleButton>
        </div>
      ) : null}
      <SearchFilters open={filtersOpen} {...filters} />
    </div>
  )
}
