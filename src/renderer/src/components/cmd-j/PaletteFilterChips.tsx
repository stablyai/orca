import React, { useMemo } from 'react'
import { ListFilter, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { buildPaletteStatusFilterOptions, type PaletteFilterModel } from './palette-filter-options'
import {
  EMPTY_PALETTE_FILTER,
  isPaletteFilterActive,
  togglePaletteFilterValue,
  type PaletteFilterField,
  type PaletteFilterState
} from './palette-filter'

type Chip = { field: PaletteFilterField; id: string; label: string }

/**
 * Show all selected axes as removable chips, falling back to IDs when labels disappear.
 * Removing a chip affects only its axis; Clear all resets scope and status together.
 */
export default function PaletteFilterChips({
  model,
  filter,
  onFilterChange
}: {
  model: PaletteFilterModel
  filter: PaletteFilterState
  onFilterChange: (next: PaletteFilterState) => void
}): React.JSX.Element | null {
  /** Resolve current model/localized labels without dropping stale selected IDs. */
  const chips = useMemo<Chip[]>(() => {
    const hostLabels = new Map(model.hosts.map((host) => [host.id, host.label]))
    const repositoryLabels = new Map(
      model.repositories.map((repository) => [repository.id, repository.label])
    )
    const statusLabels: Record<string, string> = Object.fromEntries(
      buildPaletteStatusFilterOptions().map(({ id, label }) => [id, label])
    )
    return [
      ...filter.hostIds.map((id) => ({
        field: 'host' as const,
        id,
        label: hostLabels.get(id) ?? id
      })),
      ...filter.repoIds.map((id) => ({
        field: 'repository' as const,
        id,
        label: repositoryLabels.get(id) ?? id
      })),
      ...filter.statusIds.map((id) => ({
        field: 'status' as const,
        id,
        label: statusLabels[id] ?? id
      }))
    ]
  }, [filter.hostIds, filter.repoIds, filter.statusIds, model.hosts, model.repositories])

  if (!isPaletteFilterActive(filter)) {
    return null
  }

  return (
    // Why: keep the sidebar scope and palette selections on one compact metadata line.
    <div className="mx-3 mt-2 flex items-center gap-1.5 pl-3.5 text-[11px] text-muted-foreground">
      {/* Why: a fixed anchor the eye can find at one filter, where a bare muted line vanishes. */}
      <ListFilter className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">
        {translate('worktreeJumpPalette.filter.scopedTo', 'Scoped to')}
      </span>
      {/* Why: horizontal scroll keeps every chip reachable without a hard +N dead-end. */}
      <div className="scrollbar-sleek flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {chips.map((chip, index) => (
          <React.Fragment key={`${chip.field}:${chip.id}`}>
            {index > 0 ? (
              <span className="shrink-0 opacity-50" aria-hidden="true">
                ·
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onFilterChange(togglePaletteFilterValue(filter, chip.field, chip.id))}
              aria-label={translate(
                'worktreeJumpPalette.filter.removeChip',
                'Remove filter {{value0}}',
                {
                  value0: chip.label
                }
              )}
              className="group flex h-6 max-w-[140px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
            >
              <span className="min-w-0 truncate">{chip.label}</span>
              {/* Space stays reserved so revealing the dismiss does not shift the row. */}
              <X
                className="size-2.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                aria-hidden="true"
              />
            </button>
          </React.Fragment>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onFilterChange(EMPTY_PALETTE_FILTER)}
        className="ml-1 mr-4 shrink-0 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
      >
        {translate('worktreeJumpPalette.filter.clearAll', 'Clear all')}
      </button>
    </div>
  )
}
