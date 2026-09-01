import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'

export type AgentPickerListboxItem = {
  /** Stable identity used for active-row tracking and aria wiring. Unique
   *  within the list (sentinels like Auto/Blank get their own reserved value). */
  value: string
}

export type AgentPickerListboxProps<T extends AgentPickerListboxItem> = {
  /** Already-filtered, in-display-order rows (the caller owns filtering and any
   *  Auto/Blank sentinel rows). */
  items: readonly T[]
  query: string
  onQueryChange: (query: string) => void
  onSelect: (item: T) => void
  renderItem: (item: T, state: { active: boolean }) => ReactNode
  searchPlaceholder: string
  emptyLabel: string
  /** DOM id of the listbox, owned by the caller so its trigger can point
   *  `aria-controls` at the same node. */
  listboxId: string
  listAriaLabel: string
  /** Row highlighted when the list mounts (the current selection), so the first
   *  Arrow keypress steps from it rather than the top. */
  initialActiveValue?: string | null
  setInputNode?: (node: HTMLInputElement | null) => void
  footer?: ReactNode
  rowEstimatePx?: number
}

// Bounded overscan keeps the mounted option count small even at 1,000 rows
// (plan §978: at most 60 mounted). Constrained viewport + this overscan stays
// well under that cap.
const DEFAULT_ROW_ESTIMATE_PX = 34
const ROW_OVERSCAN = 8

/**
 * A search-filtered, virtualized listbox for the agent pickers. Replaces cmdk,
 * whose mounted-items-only navigation cannot keep Arrow/Enter correct once the
 * list is windowed. Owns active-row state, keyboard navigation (Arrow/Home/End/
 * Enter), scroll-to-active so keyboard can reach unmounted rows, and the
 * listbox/option aria wiring; the caller owns the trigger, filtering, and the
 * per-row visual content.
 */
export function AgentPickerListbox<T extends AgentPickerListboxItem>({
  items,
  query,
  onQueryChange,
  onSelect,
  renderItem,
  searchPlaceholder,
  emptyLabel,
  listboxId,
  listAriaLabel,
  initialActiveValue,
  setInputNode,
  footer,
  rowEstimatePx
}: AgentPickerListboxProps<T>): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeValue, setActiveValue] = useState<string | null>(
    initialActiveValue ?? items[0]?.value ?? null
  )
  // Why: a footer hover clears the highlight on purpose, and the repair effect
  // below cannot tell that null apart from "the active row was filtered out" —
  // without this flag it would immediately snap the highlight back to row 0.
  const [highlightCleared, setHighlightCleared] = useState(false)

  const setActiveRow = useCallback((value: string | null): void => {
    setHighlightCleared(value === null)
    setActiveValue(value)
  }, [])

  // Typing reasserts a top match, so a footer-hover clear must not outlive it.
  useEffect(() => {
    setHighlightCleared(false)
  }, [query])

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.value === activeValue),
    [items, activeValue]
  )

  // Keep the active row valid as filtering changes the result set: if the active
  // value drops out, fall back to the first row (or clear when empty).
  useEffect(() => {
    if (items.length === 0) {
      if (activeValue !== null) {
        setActiveValue(null)
      }
      return
    }
    if (highlightCleared) {
      return
    }
    if (!items.some((item) => item.value === activeValue)) {
      setActiveValue(items[0].value)
    }
  }, [items, activeValue, highlightCleared])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowEstimatePx ?? DEFAULT_ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
    getItemKey: (index) => items[index].value
  })

  // Scroll the active row into the mounted window so keyboard navigation reaches
  // rows the virtualizer would otherwise leave unmounted at 1k+ items — the
  // exact case cmdk cannot handle.
  useEffect(() => {
    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, virtualizer])

  const moveActive = useCallback(
    (nextIndex: number): void => {
      const clamped = Math.max(0, Math.min(nextIndex, items.length - 1))
      const next = items[clamped]
      if (next) {
        setActiveRow(next.value)
      }
    },
    [items, setActiveRow]
  )

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveActive(activeIndex + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(activeIndex - 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        moveActive(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        moveActive(items.length - 1)
      } else if (event.key === 'Enter') {
        const item = activeIndex >= 0 ? items[activeIndex] : undefined
        if (item) {
          event.preventDefault()
          onSelect(item)
        }
      }
    },
    [activeIndex, items, moveActive, onSelect]
  )

  const optionDomId = (index: number): string => `${listboxId}-option-${index}`
  const activeDescendant = activeIndex >= 0 ? optionDomId(activeIndex) : undefined

  return (
    <div className="flex flex-col">
      <div className="relative border-b border-border">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={setInputNode}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={searchPlaceholder}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          className="h-9 w-full bg-transparent pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div
          ref={scrollRef}
          role="listbox"
          id={listboxId}
          aria-label={listAriaLabel}
          className="max-h-[18rem] scrollbar-sleek overflow-y-auto p-1"
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
              width: '100%'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index]
              const active = item.value === activeValue
              return (
                <div
                  key={virtualRow.key}
                  id={optionDomId(virtualRow.index)}
                  role="option"
                  aria-selected={active}
                  data-value={item.value}
                  data-active={active || undefined}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  onMouseEnter={() => setActiveRow(item.value)}
                  onClick={() => onSelect(item)}
                  className={cn(
                    'absolute left-0 top-0 w-full cursor-pointer rounded-sm',
                    active && 'bg-accent text-accent-foreground'
                  )}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {renderItem(item, { active })}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {/* Hovering the footer (which lives outside the option list) clears the
          highlight so a stray last-hovered row is not left visually active. */}
      {footer ? <div onMouseEnter={() => setActiveRow(null)}>{footer}</div> : null}
    </div>
  )
}
