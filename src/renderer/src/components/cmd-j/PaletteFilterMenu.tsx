import React, { useCallback, useMemo, useState } from 'react'
import { ChevronRight, ListFilter, X } from 'lucide-react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { PaletteFilterModel } from './palette-filter-options'
import {
  addPaletteFilterValues,
  clearPaletteFilterField,
  EMPTY_PALETTE_FILTER,
  getPaletteFilterSelectionCount,
  isPaletteFilterActive,
  togglePaletteFilterValue,
  type PaletteFilterField,
  type PaletteFilterState
} from './palette-filter'
import { PaletteFilterFieldOptions, type PaletteFilterGroup } from './PaletteFilterFieldOptions'

function CategoryRoot({
  groups,
  onOpenField
}: {
  groups: readonly PaletteFilterGroup[]
  onOpenField: (field: PaletteFilterField) => void
}): React.JSX.Element {
  return (
    <CommandList className="scrollbar-sleek max-h-[280px] py-1">
      <CommandGroup>
        {groups.map((group) => {
          const selectedCount = group.selected.length
          return (
            <CommandItem
              key={group.field}
              value={group.field}
              onSelect={() => onOpenField(group.field)}
              className="mx-0.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13px] data-[selected=true]:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">{group.heading}</span>
              {selectedCount > 0 ? (
                <span className="rounded-full bg-primary/85 px-1.5 text-[10px] font-semibold tabular-nums text-primary-foreground">
                  {selectedCount}
                </span>
              ) : (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                  {group.options.length}
                </span>
              )}
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground/60"
                aria-hidden="true"
              />
            </CommandItem>
          )
        })}
      </CommandGroup>
    </CommandList>
  )
}

export default function PaletteFilterMenu({
  model,
  filter,
  onFilterChange,
  onRequestInputFocus,
  portalContainer
}: {
  model: PaletteFilterModel
  filter: PaletteFilterState
  onFilterChange: (next: PaletteFilterState) => void
  onRequestInputFocus: () => void
  portalContainer: HTMLElement | null
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  // null = category root; non-null = drill into that field's options
  const [activeField, setActiveField] = useState<PaletteFilterField | null>(null)
  const [optionQuery, setOptionQuery] = useState('')

  const groups = useMemo<PaletteFilterGroup[]>(() => {
    const entries: PaletteFilterGroup[] = []
    // Why: a single host (or single project) is nothing to disambiguate between,
    // so that axis stays hidden rather than offering a no-op checkbox.
    if (model.hosts.length > 1) {
      entries.push({
        field: 'host',
        heading: translate('worktreeJumpPalette.filter.hosts', 'Hosts'),
        options: model.hosts,
        selected: filter.hostIds
      })
    }
    if (model.projects.length > 1) {
      entries.push({
        field: 'project',
        heading: translate('worktreeJumpPalette.filter.projects', 'Projects'),
        options: model.projects,
        selected: filter.projectKeys
      })
    }
    return entries
  }, [filter.hostIds, filter.projectKeys, model.hosts, model.projects])

  // Stale field falls back to root if its group disappeared mid-session.
  const activeGroup =
    activeField == null ? null : (groups.find((group) => group.field === activeField) ?? null)

  const selectionCount = getPaletteFilterSelectionCount(filter)
  const active = isPaletteFilterActive(filter)

  const resetMenuState = useCallback(() => {
    setActiveField(null)
    setOptionQuery('')
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        resetMenuState()
        return
      }
      // Single axis: skip the category step and open straight into its options.
      if (groups.length === 1) {
        setActiveField(groups[0].field)
      }
    },
    [groups, resetMenuState]
  )

  const goBackToRoot = useCallback(() => {
    setActiveField(null)
    setOptionQuery('')
  }, [])

  // Why: stopPropagation so the palette's ancestor cmdk doesn't steal keys;
  // Escape on the options layer steps back instead of closing when both axes exist.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === 'Escape' && activeGroup != null && groups.length > 1) {
        event.preventDefault()
        goBackToRoot()
      }
    },
    [activeGroup, goBackToRoot, groups.length]
  )

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      // Why: Radix would return focus to the trigger button, leaving typing dead.
      event.preventDefault()
      onRequestInputFocus()
    },
    [onRequestInputFocus]
  )

  if (groups.length === 0) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        type="button"
        aria-label={translate('worktreeJumpPalette.filter.trigger', 'Filter results')}
        data-active={active ? 'true' : undefined}
        className={cn(
          'ml-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/55 px-2 text-[12px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active && 'border-primary/45 bg-primary/12 text-foreground'
        )}
      >
        <ListFilter className="size-3.5" aria-hidden="true" />
        <span>{translate('worktreeJumpPalette.filter.label', 'Filter')}</span>
        {active ? (
          <span className="rounded-full bg-primary/85 px-1.5 text-[10px] font-semibold tabular-nums text-primary-foreground">
            {selectionCount}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        portalContainer={portalContainer}
        collisionBoundary={portalContainer ?? undefined}
        onKeyDown={handleKeyDown}
        onCloseAutoFocus={handleCloseAutoFocus}
        className="popover-wheel-scroll w-[290px] p-0"
      >
        <Command shouldFilter={false} className="bg-transparent">
          {activeGroup == null ? (
            <CategoryRoot groups={groups} onOpenField={setActiveField} />
          ) : (
            <PaletteFilterFieldOptions
              group={activeGroup}
              canGoBack={groups.length > 1}
              optionQuery={optionQuery}
              onOptionQueryChange={setOptionQuery}
              onBack={goBackToRoot}
              onToggle={(id) =>
                onFilterChange(togglePaletteFilterValue(filter, activeGroup.field, id))
              }
              onClearField={() =>
                onFilterChange(clearPaletteFilterField(filter, activeGroup.field))
              }
              onSelectAllMatching={(ids) =>
                onFilterChange(addPaletteFilterValues(filter, activeGroup.field, ids))
              }
            />
          )}
        </Command>
        {active ? (
          <div className="flex items-center justify-between border-t border-border/55 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {translate('worktreeJumpPalette.filter.activeCount', '{{value0}} active', {
                value0: selectionCount
              })}
            </span>
            <button
              type="button"
              onClick={() => onFilterChange(EMPTY_PALETTE_FILTER)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" aria-hidden="true" />
              {translate('worktreeJumpPalette.filter.clearAll', 'Clear all')}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
