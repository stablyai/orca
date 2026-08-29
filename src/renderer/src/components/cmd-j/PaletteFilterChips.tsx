import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { PaletteFilterModel } from './palette-filter-options'
import {
  EMPTY_PALETTE_FILTER,
  isPaletteFilterActive,
  togglePaletteFilterValue,
  type PaletteFilterField,
  type PaletteFilterState
} from './palette-filter'

type Chip = { field: PaletteFilterField; id: string; label: string }

export default function PaletteFilterChips({
  model,
  filter,
  onFilterChange
}: {
  model: PaletteFilterModel
  filter: PaletteFilterState
  onFilterChange: (next: PaletteFilterState) => void
}): React.JSX.Element | null {
  const chips = useMemo<Chip[]>(() => {
    const hostLabels = new Map(model.hosts.map((host) => [host.id, host.label]))
    const projectLabels = new Map(model.projects.map((project) => [project.id, project.label]))
    return [
      ...filter.hostIds.map((id) => ({
        field: 'host' as const,
        id,
        label: hostLabels.get(id) ?? id
      })),
      ...filter.projectKeys.map((id) => ({
        field: 'project' as const,
        id,
        label: projectLabels.get(id) ?? id
      }))
    ]
  }, [filter.hostIds, filter.projectKeys, model.hosts, model.projects])

  if (!isPaletteFilterActive(filter) || chips.length === 0) {
    return null
  }

  return (
    <div className="mx-3 mt-2 flex items-center gap-1.5">
      {/* Why: horizontal scroll keeps every chip reachable without a hard +N dead-end. */}
      <div className="scrollbar-sleek flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {chips.map((chip) => (
          <button
            key={`${chip.field}:${chip.id}`}
            type="button"
            onClick={() => onFilterChange(togglePaletteFilterValue(filter, chip.field, chip.id))}
            aria-label={translate(
              'worktreeJumpPalette.filter.removeChip',
              'Remove filter {{value0}}',
              {
                value0: chip.label
              }
            )}
            className="flex h-6 max-w-[140px] shrink-0 items-center gap-1 rounded-full border border-primary/35 bg-primary/12 px-2 text-[11px] text-foreground transition-colors hover:bg-primary/20"
          >
            <span className="truncate">{chip.label}</span>
            <X className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onFilterChange(EMPTY_PALETTE_FILTER)}
        className="ml-1 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {translate('worktreeJumpPalette.filter.clearAll', 'Clear all')}
      </button>
    </div>
  )
}
