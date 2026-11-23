// The long-chat list beside the rail: inline (no portal, no global Escape) so hover mode never owns focus or keys.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { Input } from '@/components/ui/input'
import { MENU_SURFACE_CLASS } from '@/components/ui/menu-surface'
import { cn } from '@/lib/class-names'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useNowSnapshot } from '@/lib/window-activity/use-now'
import {
  getNativeChatMessageDay,
  getNativeChatMessageTimeFormatter
} from '../../../../../../shared/native-chat/transcript/messages/native-chat-message-time'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import { filterNativeChatRailItems, nativeChatRailRowDisplay } from './native-chat-rail-filter'
import { nativeChatRailItemLabel } from './native-chat-rail-item-label'
import type { NativeChatRailListMode } from './use-native-chat-rail-list-open'

const ROW_PX = 28
const TIME_CLASS = 'text-xs whitespace-nowrap tabular-nums'
const MARK_CLASS = 'rounded-[2px] bg-search-match/45 text-foreground dark:bg-search-match/25'

export function NativeChatRailMessagePanel({
  panelRef,
  panelId,
  items,
  activeId,
  mode,
  focusRequest,
  onPick,
  onEscape,
  onPromote,
  onFocusLeave,
  onPointerEnter,
  onPointerLeave
}: {
  panelRef: React.RefObject<HTMLDivElement | null>
  panelId: string
  /** Loaded prompts, oldest first. */
  items: readonly NativeChatRailItem[]
  activeId: string | null
  mode: NativeChatRailListMode
  focusRequest: number
  onPick: (id: string) => void
  onEscape: () => void
  onPromote: () => void
  onFocusLeave: () => void
  onPointerEnter: (event: React.PointerEvent) => void
  onPointerLeave: (event: React.PointerEvent) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const today = useNowSnapshot(30_000, getNativeChatMessageDay)
  const focused = mode === 'focus'
  const [query, setQuery] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const sizerRef = useRef<HTMLDivElement | null>(null)
  const [timeWidth, setTimeWidth] = useState(0)
  const alignRef = useRef<'center' | 'auto'>('center')

  const results = useMemo(() => filterNativeChatRailItems(items, query), [items, query])
  const times = useMemo(() => {
    const formatter = getNativeChatMessageTimeFormatter(intlLocale, today)
    const byId = new Map<string, string>()
    for (const item of items) {
      const date = item.timestamp === null ? null : new Date(item.timestamp)
      if (date && !Number.isNaN(date.getTime())) {
        byId.set(
          item.id,
          formatter.format(date, today.date, (time) =>
            t('nativeChat.messageTime.yesterday', 'Yesterday {{time}}', { time })
          )
        )
      }
    }
    return byId
  }, [intlLocale, items, t, today])
  const distinctTimes = useMemo(() => Array.from(new Set(times.values())), [times])

  // One width for every row's time, measured from the real type, so text columns line up.
  useLayoutEffect(() => {
    const sizer = sizerRef.current
    if (!sizer) {
      return
    }
    const measure = (): void => setTimeWidth(Math.ceil(sizer.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(sizer)
    return () => observer.disconnect()
  }, [])

  let highlightIndex = results.findIndex((result) => result.item.id === highlightId)
  if (highlightIndex === -1 && results.length > 0) {
    const active = query.trim() ? -1 : results.findIndex((result) => result.item.id === activeId)
    highlightIndex = active !== -1 ? active : query.trim() ? 0 : results.length - 1
  }

  // Option ids stay with their message for the panel's life, so a moved result keeps its id.
  const optionSerials = useRef(new Map<string, number>())
  const optionId = (id: string): string => {
    let serial = optionSerials.current.get(id)
    if (serial === undefined) {
      serial = optionSerials.current.size
      optionSerials.current.set(id, serial)
    }
    return `${panelId}-opt-${serial}`
  }

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      return highlightIndex < 0 || indexes.includes(highlightIndex)
        ? indexes
        : [...indexes, highlightIndex].sort((left, right) => left - right)
    },
    [highlightIndex]
  )
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (index) => results[index]?.item.id ?? index,
    overscan: 10,
    rangeExtractor
  })
  const virtualItems = virtualizer.getVirtualItems()
  const viewportHeight = virtualizer.scrollRect?.height ?? 0

  // Keep the highlight in view when it or the results move; wheel browsing changes neither.
  useLayoutEffect(() => {
    if (highlightIndex < 0 || viewportHeight === 0) {
      return
    }
    virtualizer.scrollToIndex(highlightIndex, { align: alignRef.current })
    alignRef.current = 'auto'
  }, [highlightIndex, results, viewportHeight, virtualizer])

  // A keyboard open moves focus to the filter, also when hover had already mounted the panel.
  useLayoutEffect(() => {
    if (focused && focusRequest > 0) {
      filterRef.current?.focus()
    }
  }, [focusRequest, focused])

  const highlighted = highlightIndex < 0 ? undefined : results[highlightIndex]
  const highlightMounted = virtualItems.some((item) => item.index === highlightIndex)

  const move = (step: number): void => {
    const next = results[Math.min(results.length - 1, Math.max(0, highlightIndex + step))]
    if (next) {
      setHighlightId(next.item.id)
    }
  }
  // Enter acts on what the reader can see: an offscreen highlight is scrolled in first.
  const pickHighlighted = (): void => {
    const list = listRef.current
    if (!highlighted || !list) {
      return
    }
    const listRect = list.getBoundingClientRect()
    if (listRect.height <= 0) {
      return
    }
    const option = document.getElementById(optionId(highlighted.item.id))
    const rect = option?.getBoundingClientRect()
    if (rect && rect.bottom > listRect.top && rect.top < listRect.bottom) {
      onPick(highlighted.item.id)
      return
    }
    virtualizer.scrollToIndex(highlightIndex, { align: 'auto' })
  }

  const position = query.trim()
    ? String(results.length)
    : t('components.native-chat.railListPosition', '{{index}} / {{count}}', {
        index: highlightIndex + 1,
        count: items.length
      })
  const filterLabel = t('components.native-chat.railFilterPlaceholder', 'Filter your messages')
  const listId = `${panelId}-list`

  return (
    <div
      ref={panelRef}
      id={panelId}
      role={focused ? 'dialog' : undefined}
      aria-label={focused ? t('components.native-chat.railLabel', 'Your messages') : undefined}
      data-native-chat-rail-panel
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // A hover-opened list leaves focus where it was: only the filter takes it.
      onPointerDown={(event) => {
        if (event.target !== filterRef.current) {
          event.preventDefault()
        }
      }}
      onFocus={() => {
        if (!focused) {
          onPromote()
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) {
          return
        }
        // The window losing focus keeps the panel; the filter regains focus with it.
        if (next === null && !document.hasFocus()) {
          return
        }
        onFocusLeave()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (query.length > 0) {
          alignRef.current = 'center'
          setHighlightId(null)
          setQuery('')
          return
        }
        onEscape()
      }}
      className={cn(
        MENU_SURFACE_CLASS,
        'absolute top-1/2 right-[44px] z-20 flex max-h-[60%] w-[300px] -translate-y-1/2 flex-col rounded-[10px] p-2'
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        <Input
          ref={filterRef}
          density="compact"
          className="h-8 flex-1"
          value={query}
          placeholder={filterLabel}
          aria-label={filterLabel}
          role={focused ? 'combobox' : undefined}
          aria-controls={focused ? listId : undefined}
          aria-expanded={focused ? true : undefined}
          aria-autocomplete={focused ? 'list' : undefined}
          aria-activedescendant={
            focused && highlighted && highlightMounted ? optionId(highlighted.item.id) : undefined
          }
          onChange={(event) => {
            const next = event.target.value
            alignRef.current = next.trim() ? 'auto' : 'center'
            setHighlightId(null)
            setQuery(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              move(event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              pickHighlighted()
            }
          }}
        />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{position}</span>
      </div>
      {results.length === 0 ? (
        <p className="px-2 pt-2 pb-1 text-xs text-muted-foreground" role="status">
          {t('components.native-chat.railNoMatches', 'No messages match')}
        </p>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role={focused ? 'listbox' : undefined}
        aria-label={focused ? t('components.native-chat.railLabel', 'Your messages') : undefined}
        className={cn(
          'scrollbar-sleek relative mt-1 min-h-0 overflow-y-auto overscroll-contain',
          results.length === 0 && 'hidden'
        )}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualItem) => {
            const result = results[virtualItem.index]
            if (!result) {
              return null
            }
            const { item } = result
            const selected = virtualItem.index === highlightIndex
            const display = nativeChatRailRowDisplay(nativeChatRailItemLabel(item, t), result.match)
            const { mark } = display
            return (
              <div
                key={virtualItem.key}
                id={optionId(item.id)}
                role={focused ? 'option' : undefined}
                aria-selected={focused ? selected : undefined}
                aria-setsize={focused ? results.length : undefined}
                aria-posinset={focused ? virtualItem.index + 1 : undefined}
                tabIndex={-1}
                data-selected={selected}
                onPointerMove={() => {
                  if (highlightId !== item.id) {
                    setHighlightId(item.id)
                  }
                }}
                onClick={() => onPick(item.id)}
                className="absolute top-0 left-0 flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-popover-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {mark === null ? (
                    display.text
                  ) : (
                    <>
                      {display.text.slice(0, mark.start)}
                      <mark className={MARK_CLASS}>{display.text.slice(mark.start, mark.end)}</mark>
                      {display.text.slice(mark.end)}
                    </>
                  )}
                </span>
                <span
                  className={cn(TIME_CLASS, 'shrink-0 text-right text-muted-foreground')}
                  style={timeWidth > 0 ? { width: timeWidth } : undefined}
                >
                  {times.get(item.id) ?? ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div
        ref={sizerRef}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 h-0 w-max overflow-hidden"
      >
        {distinctTimes.map((time) => (
          <div key={time} className={TIME_CLASS}>
            {time}
          </div>
        ))}
      </div>
    </div>
  )
}
