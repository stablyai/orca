import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  PluginTaskSourceFilter,
  PluginTaskSourceQuery
} from '@/store/slices/plugin-task-sources-slice-contract'
import { TaskPagePluginSourceFacetBar, type PluginTaskSourceFacetFilter } from './FacetBar'
import { TaskPagePluginSourceScopePicker, type PluginTaskSourceScopeFilter } from './ScopePicker'

function normalizeSearch(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Long enough that a typed word is one request, short enough to feel live. */
export const PLUGIN_TASK_SOURCE_SEARCH_DEBOUNCE_MS = 300

export function TaskPagePluginSourceQueryBar({
  filters,
  facets,
  facetOptions,
  query,
  onQueryChange,
  scopeFilter
}: {
  filters: PluginTaskSourceFilter[]
  facets: PluginTaskSourceFacetFilter['facets']
  facetOptions: PluginTaskSourceFacetFilter['facetOptions']
  query: PluginTaskSourceQuery
  onQueryChange: (query: PluginTaskSourceQuery) => void
  scopeFilter: PluginTaskSourceScopeFilter
}): React.JSX.Element {
  const [searchInput, setSearchInput] = useState(query.search ?? '')
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchLabel = translate(
    'auto.components.TaskPage.pluginTaskSourceSearch',
    'Search tasks...'
  )

  useEffect(() => {
    return () => {
      if (debounce.current) {
        clearTimeout(debounce.current)
      }
    }
  }, [])

  const cancelPendingSearch = (): void => {
    if (debounce.current) {
      clearTimeout(debounce.current)
      debounce.current = null
    }
  }

  const applySearch = (value: string): void => {
    setSearchInput(value)
    cancelPendingSearch()
    debounce.current = setTimeout(() => {
      onQueryChange({ ...query, search: normalizeSearch(value) })
    }, PLUGIN_TASK_SOURCE_SEARCH_DEBOUNCE_MS)
  }

  /** Carries the typed text along: a chip pressed mid-debounce would otherwise
   *  be overwritten by the pending search a moment later. */
  const applyFilter = (filterId: string | null): void => {
    cancelPendingSearch()
    onQueryChange({ ...query, search: normalizeSearch(searchInput), filterId })
  }

  const applyFacetSelections = (facetSelections: Record<string, string[]>): void => {
    cancelPendingSearch()
    onQueryChange({ ...query, search: normalizeSearch(searchInput), facetSelections })
  }

  return (
    <div className="flex flex-none flex-col gap-2 border-b border-border/50 bg-muted/25 px-3 py-2">
      {/* Facets supersede the presets rather than joining them: both narrow the
          same list, and a preset silently fighting a facet reads as a bug. A
          source that still declares only presets keeps its chip row. */}
      {facets.length > 0 ? (
        <TaskPagePluginSourceFacetBar
          facets={facets}
          facetOptions={facetOptions}
          facetSelections={query.facetSelections}
          onFacetSelectionsChange={applyFacetSelections}
        />
      ) : null}

      {facets.length === 0 && filters.length > 0 ? (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={translate('auto.components.TaskPage.pluginTaskSourceFilters', 'Filters')}
        >
          {filters.map((filter) => {
            const active = query.filterId === filter.id
            return (
              <button
                key={filter.id}
                type="button"
                aria-pressed={active}
                onClick={() => applyFilter(active ? null : filter.id)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background'
                    : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                )}
              >
                {filter.label}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <TaskPagePluginSourceScopePicker {...scopeFilter} />
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          value={searchInput}
          onChange={(event) => applySearch(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          className="h-8"
        />
        {searchInput ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
            onClick={() => applySearch('')}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
