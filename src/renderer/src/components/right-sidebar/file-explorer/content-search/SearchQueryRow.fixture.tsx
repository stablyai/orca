import React, { useRef, useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { RightSidebarExplorerView } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import { FileExplorerNameFilter } from '../panel/FileExplorerNameFilter'
import { FileExplorerQueryStrip } from '../panel/FileExplorerQueryStrip'
import { SearchFilters } from './SearchFilters'
import { SearchQueryRow } from './SearchQueryRow'
import { useSearchFilterSummary } from './use-search-filters-disclosure'

/** The explorer's real query strip with local state; no IPC or store wiring. */
function QueryStripHarness({
  initialView = 'search',
  initialQuery = '',
  initialRegex = false,
  initialInclude = '',
  initialExclude = ''
}: {
  initialView?: RightSidebarExplorerView
  initialQuery?: string
  initialRegex?: boolean
  initialInclude?: string
  initialExclude?: string
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState(initialView)
  const [query, setQuery] = useState(initialQuery)
  const [options, setOptions] = useState({
    caseSensitive: false,
    wholeWord: false,
    regex: initialRegex
  })
  const [include, setInclude] = useState(initialInclude)
  const [exclude, setExclude] = useState(initialExclude)
  const [filtersOpen, setFiltersOpen] = useState(
    initialInclude.length > 0 || initialExclude.length > 0
  )
  const filterSummary = useSearchFilterSummary(include, exclude)

  return (
    <div className="flex h-[220px] flex-col bg-sidebar text-foreground">
      <FileExplorerQueryStrip view={view} onSelectView={setView}>
        <div className="relative min-h-8">
          <div hidden={view !== 'files'}>
            <FileExplorerNameFilter
              query={view === 'files' ? query : ''}
              onQueryChange={setQuery}
              onClear={() => setQuery('')}
            />
          </div>
          <div hidden={view !== 'search'}>
            <SearchQueryRow
              inputRef={inputRef}
              query={query}
              loading={false}
              caseSensitive={options.caseSensitive}
              wholeWord={options.wholeWord}
              useRegex={options.regex}
              filtersOpen={filtersOpen}
              filterSummary={filterSummary}
              onQueryChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Mirrors the panel's handler: Escape clears the query and leaves the field.
                if (event.key === 'Escape') {
                  event.preventDefault()
                  inputRef.current?.blur()
                  setQuery('')
                }
              }}
              onClearSearch={() => setQuery('')}
              onToggleCaseSensitive={() =>
                setOptions((current) => ({ ...current, caseSensitive: !current.caseSensitive }))
              }
              onToggleWholeWord={() =>
                setOptions((current) => ({ ...current, wholeWord: !current.wholeWord }))
              }
              onToggleRegex={() => setOptions((current) => ({ ...current, regex: !current.regex }))}
              onToggleFilters={() => setFiltersOpen((open) => !open)}
            />
          </div>
          <div hidden={view !== 'search'}>
            <SearchFilters
              open={filtersOpen}
              includePattern={include}
              excludePattern={exclude}
              onIncludeChange={setInclude}
              onExcludeChange={setExclude}
            />
          </div>
        </div>
      </FileExplorerQueryStrip>
      {/* Focusable like the real results list, so Shift+Tab from it reaches the field. */}
      <div tabIndex={0} aria-label="Results" className="px-2 pt-2 text-xs text-muted-foreground">
        <div className="rounded-md bg-accent px-2 py-1 text-foreground">cartStore.ts</div>
        <div className="px-2 py-1">CartDrawer.tsx</div>
      </div>
    </div>
  )
}

const focusSearch = (frame: HTMLElement): void => {
  frame.querySelector<HTMLInputElement>('[data-explorer-query-input="search"]')?.focus()
}

// Widths include the frame's 16px side padding: 332, 292 and 252 are 300, 260 and 220px sidebars.
export const rest = defineFixture({ width: 332, render: () => <QueryStripHarness /> })
export const focused = defineFixture({
  width: 332,
  render: () => <QueryStripHarness />,
  interact: focusSearch
})
export const withQuery = defineFixture({
  width: 332,
  render: () => <QueryStripHarness initialQuery="useCart" />
})
export const filtersSet = defineFixture({
  width: 332,
  render: () => <QueryStripHarness initialInclude="src/**" initialExclude="*.min.js, dist/**" />
})
export const filtersSetMinWidth = defineFixture({
  width: 252,
  render: () => <QueryStripHarness initialInclude="src/**" initialExclude="*.min.js, dist/**" />
})
/** Escape on a toggle, not the input, still clears the query and moves focus out of the field. */
export const escapeFromToggle = defineFixture({
  width: 332,
  render: () => <QueryStripHarness initialQuery="useCart" />,
  interact: (frame) => {
    const toggle = frame.querySelector<HTMLButtonElement>('button[aria-pressed]')
    toggle?.focus()
    toggle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
})
export const namesView = defineFixture({
  width: 332,
  render: () => <QueryStripHarness initialView="files" />
})
export const restNarrow = defineFixture({ width: 292, render: () => <QueryStripHarness /> })
export const focusedNarrow = defineFixture({
  width: 292,
  render: () => <QueryStripHarness />,
  interact: focusSearch
})
export const optionActiveNarrow = defineFixture({
  width: 292,
  render: () => <QueryStripHarness initialRegex />
})
export const longQueryNarrow = defineFixture({
  width: 292,
  render: () => <QueryStripHarness initialQuery="monthly-ledger-reconciliation-report" />,
  interact: focusSearch
})
export const longQueryMinWidth = defineFixture({
  width: 252,
  render: () => <QueryStripHarness initialQuery="monthly-ledger-reconciliation-report" />,
  interact: focusSearch
})
