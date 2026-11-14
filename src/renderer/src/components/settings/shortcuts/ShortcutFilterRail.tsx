import React from 'react'
import { Search, X } from 'lucide-react'
import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard-text'
import { formatKeybindingList } from '../../../../../shared/keybindings/formatting'
import type { KeybindingDefinition } from '../../../../../shared/keybindings/types'
import { cn } from '../../../lib/class-names'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import type { ShortcutTerminalStatus } from './shortcut-terminal-status'
import {
  isSettingsSearchQueryTooLarge,
  matchesExactSettingsSearchTerm,
  matchesSettingsSearch,
  type SettingsSearchEntry
} from '../search/settings-search'
import { getShortcutsPaneTitleSearchEntry } from './shortcuts-search'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export type ShortcutFilter = 'all' | 'modified' | 'unassigned' | 'conflicts'

export type ShortcutRowModel = {
  item: KeybindingDefinition
  groupTitle: string
  effective: readonly string[]
  modified: boolean
  warnings: readonly string[]
  terminalStatus?: ShortcutTerminalStatus
}

export type ShortcutRowsByGroup = {
  title: string
  rows: ShortcutRowModel[]
}

const SHORTCUT_FILTER_LABELS: Record<ShortcutFilter, () => string> = {
  all: () => translate('auto.components.settings.ShortcutFilterRail.filterAll', 'All'),
  modified: () => translate('auto.components.settings.ShortcutCommandBlock.287e07ddde', 'Modified'),
  unassigned: () =>
    translate('auto.components.settings.ShortcutFilterRail.filterUnassigned', 'Unassigned'),
  conflicts: () =>
    translate('auto.components.settings.ShortcutFilterRail.filterConflicts', 'Conflicts')
}

export const SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isShortcutLocalSearchQueryTooLarge(
  query: string,
  maxBytes = SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function normalizeShortcutLocalSearchQuery(query: string): string | null {
  if (isShortcutLocalSearchQueryTooLarge(query)) {
    return null
  }
  return query.trim().toLowerCase()
}

export function getShortcutSearchEntry(row: ShortcutRowModel): SettingsSearchEntry {
  return {
    title: row.item.title,
    description: translate(
      'auto.components.settings.ShortcutFilterRail.1d5634ba31',
      '{{value0}} shortcut',
      { value0: row.groupTitle }
    ),
    keywords: [...row.item.searchKeywords]
  }
}

/** Preserves all rows for exact pane aliases and filters other queries to matching commands. */
export function buildShortcutGlobalSearchMatcher(
  rows: readonly ShortcutRowModel[],
  searchQuery: string
): (row: ShortcutRowModel) => boolean {
  if (isSettingsSearchQueryTooLarge(searchQuery)) {
    return () => false
  }
  if (matchesExactSettingsSearchTerm(searchQuery, getShortcutsPaneTitleSearchEntry())) {
    return () => true
  }

  const rowMatches = (row: ShortcutRowModel): boolean =>
    matchesSettingsSearch(searchQuery, getShortcutSearchEntry(row))
  return rows.some(rowMatches) ? rowMatches : () => true
}

export function matchesShortcutFilter(row: ShortcutRowModel, filter: ShortcutFilter): boolean {
  switch (filter) {
    case 'modified':
      return row.modified
    case 'unassigned':
      return row.effective.length === 0
    case 'conflicts':
      return row.warnings.length > 0
    case 'all':
      return true
  }
}

export function matchesShortcutLocalSearch(
  row: ShortcutRowModel,
  query: string,
  platform: NodeJS.Platform
): boolean {
  if (!query) {
    return true
  }
  if (isShortcutLocalSearchQueryTooLarge(query)) {
    return false
  }
  const searchableText = [
    row.item.title,
    row.item.id,
    row.groupTitle,
    ...row.item.searchKeywords,
    formatKeybindingList(row.effective, platform)
  ]
  return searchableText.some((value) => value.toLowerCase().includes(query))
}

export function ShortcutFilterRail({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  filterCounts,
  visibleCount,
  totalCount
}: {
  query: string
  onQueryChange: (value: string) => void
  filter: ShortcutFilter
  onFilterChange: (value: ShortcutFilter) => void
  filterCounts: Record<ShortcutFilter, number>
  visibleCount: number
  totalCount: number
}): React.JSX.Element {
  const t = useTranslate()
  const filters = (Object.keys(SHORTCUT_FILTER_LABELS) as ShortcutFilter[]).map((id) => ({
    id,
    label: SHORTCUT_FILTER_LABELS[id](),
    count: filterCounts[id]
  }))

  return (
    <aside className="flex min-h-0 flex-col gap-5 xl:h-full">
      <div className="shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="shortcut-filter-search" className="text-xs font-medium">
            {t('auto.components.settings.ShortcutFilterRail.02dc7d4251', 'Find shortcuts')}
          </label>
          <span className="text-[11px] text-muted-foreground">
            {visibleCount}/{totalCount}
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="shortcut-filter-search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t(
              'auto.components.settings.ShortcutFilterRail.f733c4b89f',
              'Search command or keys'
            )}
            className="h-8 pl-8 pr-8 text-sm"
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t(
                'auto.components.settings.ShortcutFilterRail.df8466f3fc',
                'Clear shortcut search'
              )}
              onClick={() => onQueryChange('')}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>

      <nav
        aria-label={t(
          'auto.components.settings.ShortcutFilterRail.8a1e78c14b',
          'Shortcut status filters'
        )}
        className="shrink-0 space-y-2"
      >
        <p className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {t('auto.components.settings.ShortcutFilterRail.28b63545bf', 'Status')}
        </p>
        <div className="grid gap-1">
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onFilterChange(option.id)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                filter === option.id
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <span className="truncate">{option.label}</span>
              <span className="text-[11px] tabular-nums opacity-80">{option.count}</span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  )
}
