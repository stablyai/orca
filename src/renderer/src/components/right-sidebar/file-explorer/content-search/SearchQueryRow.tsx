import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React from 'react'
import {
  Search as SearchIcon,
  CaseSensitive,
  WholeWord,
  Regex,
  X,
  Loader2,
  ListFilter
} from 'lucide-react'
import { cn } from '@/lib/class-names'
import { ToggleButton } from './SearchResultItems'
import { useTranslate } from '@/i18n/use-translate'
import {
  EXPLORER_QUERY_FIELD_CLASS,
  EXPLORER_QUERY_INPUT_CLASS
} from '../panel/explorer-query-field-class'

export type SearchQueryRowProps = {
  inputRef: React.Ref<HTMLInputElement>
  query: string
  loading: boolean
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  filtersOpen: boolean
  /** Include/exclude patterns in effect, e.g. "src/**, !dist/**"; empty when none. */
  filterSummary: string
  filtersRegionId?: string
  onQueryChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onClearSearch: () => void
  onToggleCaseSensitive: () => void
  onToggleWholeWord: () => void
  onToggleRegex: () => void
  onToggleFilters: () => void
}

export function SearchQueryRow({
  inputRef,
  query,
  loading,
  caseSensitive,
  wholeWord,
  useRegex,
  filtersOpen,
  filterSummary,
  filtersRegionId,
  onQueryChange,
  onKeyDown,
  onClearSearch,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  onToggleFilters
}: SearchQueryRowProps): React.JSX.Element {
  const t = useTranslate()
  const hasFilters = filterSummary.length > 0
  // Why: anything narrowing the results stays visible at rest so it never filters silently.
  const pinOptions =
    query.length > 0 || caseSensitive || wholeWord || useRegex || filtersOpen || hasFilters
  const filtersLabel = t('fileSearch.filters.toggle', 'Toggle search details')
  const handleFieldKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Why: Escape clears and leaves from any control in the field, not only the input.
    // The input handles its own keys behind the IME guard, so skip it here.
    if (event.key !== 'Escape' || event.target instanceof HTMLInputElement) {
      return
    }
    if (event.target instanceof HTMLElement) {
      event.target.blur()
    }
    onKeyDown(event)
  }
  return (
    <div className="@container">
      <div
        className={cn('group/search', EXPLORER_QUERY_FIELD_CLASS)}
        data-ignore-file-explorer-keys="true"
        onKeyDown={handleFieldKeyDown}
      >
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <ImeInput
          ref={inputRef}
          type="text"
          data-file-search-input="true"
          data-explorer-query-input="search"
          className={EXPLORER_QUERY_INPUT_CLASS}
          aria-label={t('auto.components.right.sidebar.SearchQueryRow.queryLabel', 'Search files')}
          placeholder={t('auto.components.right.sidebar.SearchHeader.693cbeadd0', 'Search')}
          value={query}
          onChange={onQueryChange}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        {loading ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <span
          className={cn(
            'flex shrink-0 items-center',
            // Why: invisible, not hidden, so revealing the options never shifts the input.
            pinOptions
              ? 'visible'
              : 'invisible group-hover/search:visible group-focus-within/search:visible'
          )}
          onMouseDown={(event) => {
            // Why: the options keep the query input's focus, but the disclosure takes it, since
            // closing the filters unmounts a focused include/exclude input and drops focus.
            const disclosure =
              event.target instanceof Element ? event.target.closest('[aria-expanded]') : null
            if (!disclosure || !event.currentTarget.contains(disclosure)) {
              event.preventDefault()
            }
          }}
        >
          {query ? (
            // Why: in a near-minimum sidebar the query needs the room; Escape still clears.
            <span className="mr-1 flex @max-[240px]:hidden">
              <ToggleButton
                onClick={onClearSearch}
                title={t('auto.components.right.sidebar.SearchQueryRow.clearLabel', 'Clear search')}
              >
                <X className="size-3.5" />
              </ToggleButton>
            </span>
          ) : null}
          <ToggleButton
            active={caseSensitive}
            onClick={onToggleCaseSensitive}
            title={t('auto.components.right.sidebar.SearchHeader.464ae3974f', 'Match Case')}
          >
            <CaseSensitive className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            active={wholeWord}
            onClick={onToggleWholeWord}
            title={t('auto.components.right.sidebar.SearchHeader.4567e6e0b6', 'Match Whole Word')}
          >
            <WholeWord className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            active={useRegex}
            onClick={onToggleRegex}
            title={t(
              'auto.components.right.sidebar.SearchHeader.6234a5ef85',
              'Use Regular Expression'
            )}
          >
            <Regex className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            highlighted={filtersOpen || hasFilters}
            ariaExpanded={filtersOpen}
            ariaControls={filtersRegionId}
            onClick={onToggleFilters}
            title={hasFilters ? `${filtersLabel} (${filterSummary})` : filtersLabel}
          >
            <ListFilter className="size-3.5" />
          </ToggleButton>
        </span>
      </div>
    </div>
  )
}
