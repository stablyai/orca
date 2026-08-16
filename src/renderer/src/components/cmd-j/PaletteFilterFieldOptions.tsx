import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronLeft, SearchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { PaletteFilterOption } from './palette-filter-options'
import type { PaletteFilterField } from './palette-filter'
import {
  FILTER_OPTION_LIST_MAX_HEIGHT,
  FILTER_OPTION_ROW_HEIGHT,
  rankPaletteFilterOptions,
  type FilterOptionRankMode
} from './palette-filter-option-list'

export type PaletteFilterGroup = {
  field: PaletteFilterField
  heading: string
  options: readonly PaletteFilterOption[]
  selected: readonly string[]
}

function FilterOptionRow({
  option,
  isSelected,
  isActive,
  onToggle
}: {
  option: PaletteFilterOption
  isSelected: boolean
  isActive: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-active={isActive ? 'true' : undefined}
      onClick={onToggle}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 px-2.5 text-left text-[13px] outline-none',
        isActive ? 'bg-accent' : 'hover:bg-accent/70'
      )}
      style={{ height: FILTER_OPTION_ROW_HEIGHT }}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
          isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70'
        )}
      >
        {isSelected ? <Check className="size-3" aria-hidden="true" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
        {option.count}
      </span>
    </button>
  )
}

export function PaletteFilterFieldOptions({
  group,
  canGoBack,
  optionQuery,
  onOptionQueryChange,
  onBack,
  onToggle,
  onClearField,
  onSelectAllMatching
}: {
  group: PaletteFilterGroup
  canGoBack: boolean
  optionQuery: string
  onOptionQueryChange: (value: string) => void
  onBack: () => void
  onToggle: (id: string) => void
  onClearField: () => void
  onSelectAllMatching: (ids: readonly string[]) => void
}): React.JSX.Element {
  const selected = useMemo(() => new Set(group.selected), [group.selected])
  const normalizedQuery = optionQuery.trim().toLowerCase()
  const rankMode: FilterOptionRankMode = group.field === 'host' ? 'registry' : 'popularity'
  const ranked = useMemo(
    () =>
      rankPaletteFilterOptions({
        options: group.options,
        selectedIds: selected,
        query: normalizedQuery,
        rankMode
      }),
    [group.options, selected, normalizedQuery, rankMode]
  )

  // State, not a ref: the scroller unmounts on an empty list, and the wheel
  // listener has to re-attach to the node that replaces it.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Why the field/query are stored alongside the index instead of reset in an
  // effect: a stale row would stay active for one paint. Why not key off the
  // ranked list identity: a toggle re-ranks, so that would yank the cursor back
  // to the top mid multi-select.
  const [highlight, setHighlight] = useState(() => ({
    field: group.field,
    query: normalizedQuery,
    index: 0
  }))
  const storedIndex =
    highlight.field === group.field && highlight.query === normalizedQuery ? highlight.index : 0
  // The stored index can outlive the rows it pointed at when the list shrinks.
  const activeIndex = Math.min(storedIndex, Math.max(0, ranked.ordered.length - 1))

  useEffect(() => {
    inputRef.current?.focus()
  }, [group.field])

  const virtualizer = useVirtualizer({
    count: ranked.ordered.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => FILTER_OPTION_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => ranked.ordered[index]?.id ?? index
  })

  // Same wheel workaround as CommandList: Radix remove-scroll cancels wheel on portaled content.
  useEffect(() => {
    const el = scrollEl
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollHeight <= el.clientHeight) {
        return
      }
      event.preventDefault()
      el.scrollTop += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scrollEl])

  const moveActive = useCallback(
    (delta: number) => {
      if (ranked.ordered.length === 0) {
        return
      }
      const next = Math.max(0, Math.min(ranked.ordered.length - 1, activeIndex + delta))
      virtualizer.scrollToIndex(next, { align: 'auto' })
      setHighlight({ field: group.field, query: normalizedQuery, index: next })
    },
    [activeIndex, group.field, normalizedQuery, ranked.ordered.length, virtualizer]
  )

  const handleListKeyDown = useCallback(
    // Space toggles only from the listbox; in the search input it stays a
    // typeable character, and labels like "Delta Host" need it.
    (event: React.KeyboardEvent, allowSpaceToToggle = true) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveActive(1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(-1)
        return
      }
      if (event.key === 'Enter' || (allowSpaceToToggle && event.key === ' ')) {
        const option = ranked.ordered[activeIndex]
        if (!option) {
          return
        }
        event.preventDefault()
        onToggle(option.id)
      }
    },
    [activeIndex, moveActive, onToggle, ranked.ordered]
  )

  const searchPlaceholder =
    group.field === 'host'
      ? translate('worktreeJumpPalette.filter.searchHosts', 'Filter hosts...')
      : translate('worktreeJumpPalette.filter.searchProjects', 'Filter projects...')
  const emptyLabel =
    group.field === 'host'
      ? translate('worktreeJumpPalette.filter.noHosts', 'No matching hosts')
      : translate('worktreeJumpPalette.filter.noProjects', 'No matching projects')
  // Why a dedicated string per field: lowercasing a translated heading breaks in
  // languages that capitalize nouns mid-sentence (German "Projekte").
  const clearLabel =
    group.field === 'host'
      ? translate('worktreeJumpPalette.filter.clearHosts', 'Clear hosts')
      : translate('worktreeJumpPalette.filter.clearProjects', 'Clear projects')

  const canSelectAll = ranked.unselectedCount > 0
  const canClear = ranked.selectedCount > 0

  return (
    <>
      {canGoBack ? (
        <div className="flex items-center gap-1 border-b border-border/55 px-1.5 py-1">
          <button
            type="button"
            onClick={onBack}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            {translate('worktreeJumpPalette.filter.back', 'Back')}
          </button>
          <span className="min-w-0 flex-1 truncate pr-2 text-[12px] font-medium text-foreground">
            {group.heading}
          </span>
        </div>
      ) : null}
      <div
        className="flex items-center border-b border-border/55 bg-muted/30 px-3"
        data-cmdk-input-wrapper=""
      >
        <SearchIcon
          className="mr-2 size-3.5 shrink-0 text-muted-foreground/60"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          value={optionQuery}
          onChange={(event) => onOptionQueryChange(event.target.value)}
          onKeyDown={(event) => handleListKeyDown(event, false)}
          placeholder={searchPlaceholder}
          className="h-9 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          aria-label={searchPlaceholder}
        />
      </div>
      {ranked.selectedCollapsed ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/55 px-2.5 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {translate(
              'worktreeJumpPalette.filter.selectedCollapsed',
              '{{value0}} selected — remove via chips or Clear',
              { value0: ranked.selectedCount }
            )}
          </span>
          <button
            type="button"
            onClick={onClearField}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {clearLabel}
          </button>
        </div>
      ) : null}
      {ranked.ordered.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div
          ref={setScrollEl}
          role="listbox"
          aria-multiselectable="true"
          aria-label={group.heading}
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
          className="popover-scroll-content scrollbar-sleek overflow-y-auto py-1"
          style={{ maxHeight: FILTER_OPTION_LIST_MAX_HEIGHT }}
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const option = ranked.ordered[virtualItem.index]
              if (!option) {
                return null
              }
              return (
                <div
                  key={virtualItem.key}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`
                  }}
                >
                  <FilterOptionRow
                    option={option}
                    isSelected={selected.has(option.id)}
                    isActive={virtualItem.index === activeIndex}
                    onToggle={() => onToggle(option.id)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {canSelectAll || canClear ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/55 px-2 py-1.5">
          {canSelectAll ? (
            <button
              type="button"
              onClick={() => onSelectAllMatching(ranked.unselectedIds)}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {translate(
                'worktreeJumpPalette.filter.selectAllMatching',
                'Select all matching ({{value0}})',
                { value0: ranked.unselectedCount }
              )}
            </button>
          ) : (
            <span />
          )}
          {canClear ? (
            <button
              type="button"
              onClick={onClearField}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {clearLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
