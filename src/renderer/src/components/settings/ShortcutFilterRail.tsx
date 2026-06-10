import React from 'react'
import { Search, X } from 'lucide-react'
import { formatKeybindingList, type KeybindingDefinition } from '../../../../shared/keybindings'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { ShortcutTerminalStatus } from './ShortcutBindingRow'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'

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

const SHORTCUT_FILTER_LABELS: Record<ShortcutFilter, string> = {
  all: 'All',
  modified: 'Modified',
  unassigned: 'Unassigned',
  conflicts: 'Conflicts'
}

export function getShortcutSearchEntry(row: ShortcutRowModel): SettingsSearchEntry {
  return {
    title: row.item.title,
    description: translate("auto.components.settings.ShortcutFilterRail.1d5634ba31", "{{value0}} shortcut", { value0: row.groupTitle }),
    keywords: [...row.item.searchKeywords]
  }
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
  const filters = (Object.keys(SHORTCUT_FILTER_LABELS) as ShortcutFilter[]).map((id) => ({
    id,
    label: SHORTCUT_FILTER_LABELS[id],
    count: filterCounts[id]
  }))

  return (
    <aside className="flex min-h-0 flex-col gap-5 xl:h-full">
      <div className="shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="shortcut-filter-search" className="text-xs font-medium">
            {translate("auto.components.settings.ShortcutFilterRail.02dc7d4251", "Find shortcuts")}</label>
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
            placeholder={translate("auto.components.settings.ShortcutFilterRail.f733c4b89f", "Search command or keys")}
            className="h-8 pl-8 pr-8 text-sm"
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate("auto.components.settings.ShortcutFilterRail.df8466f3fc", "Clear shortcut search")}
              onClick={() => onQueryChange('')}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>

      <nav aria-label={translate("auto.components.settings.ShortcutFilterRail.8a1e78c14b", "Shortcut status filters")} className="shrink-0 space-y-2">
        <p className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {translate("auto.components.settings.ShortcutFilterRail.28b63545bf", "Status")}</p>
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
