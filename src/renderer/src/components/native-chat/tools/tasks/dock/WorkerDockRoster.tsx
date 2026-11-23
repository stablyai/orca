import { useTranslate } from '@/i18n/use-translate'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { useNativeChatToolRunWindow } from '../../runs/use-native-chat-tool-run-window'
import { Button } from '@/components/ui/button'
import {
  workerDockClearable,
  workerDockNeedsAttention
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { WorkerDockRowView } from './WorkerDockRow'
import { WorkerDockItem } from './WorkerDockItem'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { workerDockSummary } from './worker-dock-summary'
import { WorkerDockHeader } from './WorkerDockHeader'
import { useWorkerDockScroll } from './use-worker-dock-scroll'
import { workerDockAnchorIndex, type WorkerDockScrollAnchor } from './worker-dock-scroll-anchor'
import { workerDockRosterBudget } from './worker-dock-roster-budget'

export function WorkerDockRoster(props: {
  identities: readonly {
    id: string
    state: WorkerDockRowView['state']
    ownerActionsAvailable?: boolean
    settlement?: string | null
    hasModel?: boolean
  }[]
  countIdentities?: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[]
  rows: ReadonlyMap<string, WorkerDockRowView>
  narrow: boolean
  compact?: boolean
  visible: boolean
  incomplete?: boolean
  stopAll?: { pending: boolean; onStop: () => void }
  expanded: boolean
  onExpandedChange: (value: boolean) => void
  pending: ReadonlySet<string>
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
  onClearAll: () => void
  loadWindow?: (anchor: string) => Promise<void>
}) {
  const t = useTranslate()
  const onOpen = useLatestHandler(props.onOpen)
  const onAction = useLatestHandler(props.onAction)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const summary = useRef<HTMLButtonElement>(null)
  const anchor = useRef<WorkerDockScrollAnchor | null>(null)
  const [held, setHeld] = useState<
    | readonly {
        id: string
        state: WorkerDockRowView['state']
        ownerActionsAvailable?: boolean
        hasModel?: boolean
      }[]
    | null
  >(null)
  const [active, setActive] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const current = useMemo(
    () => new Map(props.identities.map((row) => [row.id, row])),
    [props.identities]
  )
  // A held order keeps rows from jumping under the pointer, but never keeps a row that left (a
  // cleared or finished worker goes at once) and never hides one that arrived (it joins the end).
  const identities = useMemo(() => {
    if (!held) {
      return props.identities
    }
    const kept = held.flatMap((row) => current.get(row.id) ?? [])
    const keptIds = new Set(kept.map((row) => row.id))
    return [...kept, ...props.identities.filter((row) => !keptIds.has(row.id))]
  }, [held, props.identities, current])
  const orderHeld = identities.some((row, index) => row.id !== props.identities[index]?.id)
  const clearing = props.identities.some(
    (row) => (row.state === 'failed' || row.state === 'unexpected') && props.pending.has(row.id)
  )
  const clearable = props.identities.filter(workerDockClearable).length
  const {
    mixed,
    total,
    count,
    needsYou,
    failures: failed
  } = workerDockSummary(props.countIdentities ?? props.identities, props.rows, t)
  const [budget, setBudget] = useState(props.narrow ? 200 : 160)
  const items = useMemo(
    () =>
      identities.map((row, index) => ({
        ...row,
        heading:
          index === 0 ||
          workerDockNeedsAttention(identities[index - 1].state) !==
            workerDockNeedsAttention(row.state),
        lead: index === 0 && workerDockNeedsAttention(row.state)
      })),
    [identities]
  )
  const small = items.length <= 30
  const activeIndex = useMemo(
    () => items.findIndex((row) => row.id === (focused ?? active)),
    [items, active, focused]
  )
  const rowKeys = useMemo(() => items.map((item) => ({ key: item.id })), [items])
  const estimateSize = useCallback(
    (index: number) =>
      (items[index].lead ? 120 : props.narrow ? 64 : 40) + (items[index].heading ? 24 : 0),
    [items, props.narrow]
  )
  const extractRange = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = defaultRangeExtractor(range)
      return activeIndex >= 0 && !indices.includes(activeIndex)
        ? [...indices, activeIndex].sort((a, b) => a - b)
        : indices
    },
    [activeIndex]
  )
  const rowWindow = useNativeChatToolRunWindow({
    rows: rowKeys,
    scrollerRef: viewport,
    isVisible: props.visible,
    drawsEveryRow: small,
    estimateSize,
    rangeExtractor: extractRange,
    enabled: props.expanded && !small
  })
  const virtual = rowWindow.virtualizer
  const visibleItems = rowWindow.drawn
  const modelColumn =
    props.identities.some((row) => row.hasModel) ||
    [...props.rows.values()].some((row) => row.model)
  // Sized from the pane and the rows' layout, never from the scroll position: scrolling moves the
  // list, it never resizes it.
  const measure = useLatestHandler(() => {
    const element = viewport.current
    if (element) {
      setBudget(workerDockRosterBudget(root.current, element, props.narrow, orderHeld))
    }
  })
  useLayoutEffect(measure, [measure, props.expanded, props.narrow, orderHeld, items.length])
  useEffect(() => {
    const pane = root.current?.closest('[data-native-chat-root]')
    if (!pane || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [measure])
  const loadVisibleWindow = useLatestHandler(() => {
    const first = visibleItems.find((item) => item.end > (viewport.current?.scrollTop ?? 0))
    const key = first ? items[first.index]?.id : undefined
    if (key && !props.rows.has(key)) {
      void props.loadWindow?.(key)
    }
  })
  const firstVisibleKey = visibleItems[0]?.index
  useEffect(loadVisibleWindow, [firstVisibleKey, props.rows, loadVisibleWindow])
  const preserveAnchor = useLatestHandler(() => {
    if (!anchor.current || !viewport.current) {
      return
    }
    const saved = anchor.current
    const target = workerDockAnchorIndex(saved, items)
    if (target < 0) {
      return
    }
    const offset = small
      ? viewport.current.querySelector<HTMLElement>(`[data-index="${target}"]`)?.offsetTop
      : virtual.getOffsetForIndex(target, 'start')?.[0]
    if (offset !== undefined) {
      viewport.current.scrollTop = offset + saved.offset
    }
  })
  const identityOrder = items.map((row) => row.id).join('|')
  useLayoutEffect(preserveAnchor, [identityOrder, props.rows, preserveAnchor])
  const hold = () => setHeld((previous) => previous ?? props.identities)
  const release = () => {
    if (!root.current?.contains(document.activeElement) && !root.current?.matches(':hover')) {
      setHeld(null)
      setActive(null)
    }
  }
  const scrollTo = (index: number) => {
    hold()
    const target = Math.max(0, Math.min(index, items.length - 1))
    if (small && viewport.current) {
      viewport.current.scrollTop =
        viewport.current.querySelector<HTMLElement>(`[data-index="${target}"]`)?.offsetTop ?? 0
    } else {
      virtual.scrollToIndex(target, { align: 'start' })
    }
  }
  const scrollHandlers = useWorkerDockScroll({
    small,
    viewport,
    virtual,
    items,
    onAnchorChange: (value) => {
      anchor.current = { ...value, order: items }
    },
    onScrolled: hold,
    scrollTo
  })
  // A row that leaves while it holds focus (Clear, say) hands focus to the row that takes its
  // place, or to the header, so the keyboard never drops to the page.
  const lastFocus = useRef<{ id: string; index: number } | null>(null)
  useLayoutEffect(() => {
    const saved = lastFocus.current
    if (!saved || items.some((row) => row.id === saved.id)) {
      return
    }
    lastFocus.current = null
    const focusedNow = document.activeElement
    if (focusedNow && focusedNow !== document.body) {
      return
    }
    const next = items[Math.min(saved.index, items.length - 1)]
    const target = next
      ? viewport.current?.querySelector<HTMLElement>(
          `[data-worker-dock-row="${CSS.escape(next.id)}"] [data-worker-dock-open]`
        )
      : null
    ;(target ?? summary.current)?.focus()
  }, [items])
  if (!total && !identities.length && !props.incomplete) {
    return null
  }
  return (
    <div
      ref={root}
      data-native-chat-background-tasks="true"
      className="min-h-0 min-w-0 overflow-hidden rounded-xl border border-border bg-chat-canvas bg-[linear-gradient(var(--color-chat-composer-surface),var(--color-chat-composer-surface))] text-xs text-muted-foreground shadow-sm"
      onPointerEnter={hold}
      onPointerOverCapture={(event) => {
        const row =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-worker-dock-row]')
            : null
        setActive(row?.dataset.workerDockRow ?? null)
      }}
      onPointerLeave={() => {
        if (!root.current?.contains(document.activeElement)) {
          setActive(null)
        }
        release()
      }}
      onFocusCapture={(event) => {
        hold()
        const row =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-worker-dock-row]')
            : null
        if (row) {
          const id = row.dataset.workerDockRow ?? null
          setFocused(id)
          lastFocus.current = id
            ? { id, index: items.findIndex((item) => item.id === id) }
            : lastFocus.current
          row.scrollIntoView({ block: 'nearest' })
        }
      }}
      onBlurCapture={() =>
        queueMicrotask(() => {
          if (!root.current?.contains(document.activeElement)) {
            lastFocus.current = null
          }
          setFocused(
            document.activeElement?.closest<HTMLElement>('[data-worker-dock-row]')?.dataset
              .workerDockRow ?? null
          )
          release()
        })
      }
    >
      <WorkerDockHeader
        narrow={props.narrow}
        expanded={props.expanded}
        incomplete={props.incomplete}
        count={count}
        clearable={clearable}
        failed={failed}
        needsYou={needsYou}
        clearing={clearing}
        listId={id}
        summary={summary}
        onToggle={() => {
          setHeld(null)
          props.onExpandedChange(!props.expanded)
        }}
        onClear={props.onClearAll}
        stopAll={props.stopAll}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {count}
      </span>
      {props.expanded ? (
        <>
          {orderHeld ? (
            <div className="flex h-7 items-center justify-between px-4 text-xs">
              <span>{t('components.native-chat.workerDock.orderHeld', 'Order held')}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setHeld(null)
                  if (viewport.current) {
                    viewport.current.scrollTop = 0
                  }
                }}
              >
                {t('components.native-chat.workerDock.showLatest', 'Show latest')}
              </Button>
            </div>
          ) : null}
          <div
            ref={viewport}
            id={id}
            role="region"
            aria-label={t('components.native-chat.workerDock.workersRegion', 'Workers')}
            tabIndex={0}
            className="scrollbar-sleek min-h-0 overflow-y-auto overscroll-contain border-t border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ maxHeight: budget }}
            onScroll={scrollHandlers.onScroll}
            onKeyDown={scrollHandlers.onKeyDown}
          >
            <div
              style={{
                height: small ? 'auto' : rowWindow.totalSize,
                paddingBottom: undefined,
                position: 'relative'
              }}
            >
              {visibleItems.map((item) => {
                const identity = items[item.index]
                const row = props.rows.get(identity.id)
                return (
                  <WorkerDockItem
                    key={identity.id}
                    index={item.index}
                    identity={identity}
                    row={row}
                    small={small}
                    start={item.start}
                    measure={rowWindow.measureRow}
                    narrow={props.narrow}
                    compact={props.compact}
                    mixed={mixed}
                    modelColumn={modelColumn}
                    visible={props.visible}
                    pending={row ? props.pending.has(row.id) : false}
                    orderHeld={orderHeld}
                    onOpen={onOpen}
                    onAction={onAction}
                  />
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
