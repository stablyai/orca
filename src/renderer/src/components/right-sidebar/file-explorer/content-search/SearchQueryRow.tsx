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
  /** Include/exclude patterns in effect, e.g. "Include: src/** · Exclude: dist/**"; empty when none. */
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
            // Why: transparent, not invisible or hidden, so the options stay in the tab order and
            // the a11y tree, tabbing onto one reveals them, and revealing never shifts the input.
            // Unrevealed they also ignore the pointer, so a click can't hit a control it can't see;
            // the field (group/search), not this span, carries hover and focus-within to lift that.
            // Touch has no hover, so coarse pointers always show them.
            pinOptions
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 group-hover/search:pointer-events-auto group-hover/search:opacity-100 group-focus-within/search:pointer-events-auto group-focus-within/search:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100'
          )}
          onMouseDown={(event) => {
            // Why: the options keep the query input's focus, but the disclosure takes it, since
            // closing the filters unmounts a focused include/exclude input and drops focus.
            // Focus it explicitly: some engines don't focus a button on click.
            event.preventDefault()
            const disclosure =
              event.target instanceof Element ? event.target.closest('[aria-expanded]') : null
            if (
              event.button === 0 &&
              disclosure instanceof HTMLElement &&
              event.currentTarget.contains(disclosure)
            ) {
              disclosure.focus({ preventScroll: true })
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
