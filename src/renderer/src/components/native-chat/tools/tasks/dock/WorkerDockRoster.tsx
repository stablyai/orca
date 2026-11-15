import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { workerDockNeedsAttention } from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { WorkerDockRowView } from './WorkerDockRow'
import { WorkerDockItem } from './WorkerDockItem'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { workerDockSummary } from './worker-dock-summary'
import { WorkerDockHeader } from './WorkerDockHeader'
import { useWorkerDockScroll } from './use-worker-dock-scroll'

export function WorkerDockRoster(props: {
  identities: readonly {
    id: string
    state: WorkerDockRowView['state']
    ownerActionsAvailable?: boolean
    hasModel?: boolean
  }[]
  countIdentities?: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[]
  rows: ReadonlyMap<string, WorkerDockRowView>
  narrow: boolean
  visible: boolean
  incomplete?: boolean
  expanded: boolean
  onExpandedChange: (value: boolean) => void
  pending: ReadonlySet<string>
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
  onClearAll: () => void
  loadWindow?: (anchor: string) => Promise<void>
}) {
  const onOpen = useLatestHandler(props.onOpen)
  const onAction = useLatestHandler(props.onAction)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const summary = useRef<HTMLButtonElement>(null)
  const anchor = useRef<{ id: string; offset: number; index: number } | null>(null)
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
  const [browsing, setBrowsing] = useState(false)
  const cached = useRef(new Map<string, WorkerDockRowView>())
  for (const [key, row] of props.rows) {
    cached.current.set(key, row)
  }
  for (const key of cached.current.keys()) {
    if (!props.rows.has(key) && key !== active && key !== focused) {
      cached.current.delete(key)
    }
  }
  const current = useMemo(
    () => new Map(props.identities.map((row) => [row.id, row])),
    [props.identities]
  )
  const identities = useMemo(
    () =>
      (held ?? props.identities).filter(
        (row) => current.has(row.id) || active === row.id || focused === row.id
      ),
    [held, props.identities, active, focused, current]
  )
  const orderHeld =
    held !== null &&
    JSON.stringify(held.map((row) => [row.id, workerDockNeedsAttention(row.state)])) !==
      JSON.stringify(props.identities.map((row) => [row.id, workerDockNeedsAttention(row.state)]))
  const clearing = props.identities.some(
    (row) => (row.state === 'failed' || row.state === 'unexpected') && props.pending.has(row.id)
  )
  const clearUnavailable = props.identities.some(
    (row) =>
      (row.state === 'failed' || row.state === 'unexpected') &&
      (row.ownerActionsAvailable === false ||
        cached.current.get(row.id)?.ownerActionsAvailable === false)
  )
  const { failures } = workerDockSummary(props.identities, cached.current)
  const { mixed, total, count } = workerDockSummary(
    props.countIdentities ?? props.identities,
    cached.current
  )
  const [height, setHeight] = useState(props.narrow ? 120 : 100)
  const [more, setMore] = useState(false)
  const items = useMemo(
    () =>
      identities.map((row, index) => ({
        ...row,
        heading:
          index === 0 ||
          workerDockNeedsAttention(identities[index - 1].state) !==
            workerDockNeedsAttention(row.state)
      })),
    [identities]
  )
  const small = items.length <= 30
  const activeIndex = useMemo(
    () => items.findIndex((row) => row.id === (focused ?? active)),
    [items, active, focused]
  )
  const itemKey = useCallback((index: number) => items[index].id, [items])
  const estimateSize = useCallback(
    (index: number) => (props.narrow ? 64 : 40) + (items[index].heading ? 24 : 0),
    [items, props.narrow]
  )
  const scrollElement = useCallback(() => viewport.current, [])
  const extractRange = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = defaultRangeExtractor(range)
      return activeIndex >= 0 && !indices.includes(activeIndex)
        ? [...indices, activeIndex].sort((a, b) => a - b)
        : indices
    },
    [activeIndex]
  )
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: scrollElement,
    getItemKey: itemKey,
    estimateSize,
    overscan: 3,
    rangeExtractor: extractRange,
    enabled: props.expanded && !small
  })
  const visibleItems = small
    ? items.map((row, index) => ({ key: row.id, index, start: 0, end: 0, size: 0 }))
    : virtual.getVirtualItems()
  const modelColumn =
    props.identities.some((row) => row.hasModel) ||
    [...props.rows.values()].some((row) => row.model)
  const measure = () => {
    const element = viewport.current
    if (!element) {
      return
    }
    const pane = root.current?.closest('[data-native-chat-root]')?.getBoundingClientRect()
    const short = (pane?.height ?? window.innerHeight) < 520
    const nominal = props.narrow ? (short ? 120 : 200) : short ? 100 : 160
    const joined = root.current
      ?.closest('[data-native-chat-worker-dock]')
      ?.getBoundingClientRect().height
    const budget = joined
      ? Math.min(
          nominal,
          Math.max(0, joined - (props.narrow ? 44 : 32) - 24 - (orderHeld ? 28 : 0))
        )
      : nominal
    const start = element.scrollTop
    let end = start
    const measured = small
      ? [...element.querySelectorAll<HTMLElement>('[data-index]')].map((node) => ({
          start: node.offsetTop,
          end: node.offsetTop + node.offsetHeight
        }))
      : virtual.getVirtualItems()
    for (const item of measured) {
      if (item.end <= start + 1) {
        continue
      }
      if (item.end - start > budget && end > start) {
        break
      }
      end = item.end
    }
    const totalSize = small
      ? (element.firstElementChild?.scrollHeight ?? 0)
      : virtual.getTotalSize()
    const next = Math.max(24, Math.min(end - start, totalSize - start))
    setHeight(next)
    setMore(end < totalSize - 1)
  }
  useLayoutEffect(measure)
  const resize = useLatestHandler(measure)
  useEffect(() => {
    const pane = root.current?.closest('[data-native-chat-root]')
    if (!pane) {
      return
    }
    const observer = new ResizeObserver(resize)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [resize])
  const loadVisibleWindow = useLatestHandler(() => {
    const first = visibleItems.find((item) => item.end > (viewport.current?.scrollTop ?? 0))
    const key = first ? items[first.index]?.id : undefined
    if (key && !props.rows.has(key)) {
      void props.loadWindow?.(key)
    }
  })
  const firstVisibleKey = visibleItems.find(
    (item) => item.end > (viewport.current?.scrollTop ?? 0)
  )?.key
  useEffect(loadVisibleWindow, [firstVisibleKey, props.rows, loadVisibleWindow])
  const preserveAnchor = useLatestHandler(() => {
    if (!anchor.current || !viewport.current) {
      return
    }
    const saved = anchor.current
    const index = items.findIndex((row) => row.id === saved.id)
    const target = index !== -1 ? index : Math.min(saved.index, items.length - 1)
    const offset = small
      ? viewport.current.querySelector<HTMLElement>(`[data-index="${target}"]`)?.offsetTop
      : virtual.getOffsetForIndex(target, 'start')?.[0]
    if (offset !== undefined) {
      viewport.current.scrollTop = offset + saved.offset
    }
  })
  const identityOrder = items.map((row) => row.id).join('|')
  useLayoutEffect(preserveAnchor, [identityOrder, preserveAnchor])
  const hold = () => setHeld((previous) => previous ?? props.identities)
  const release = () => {
    if (
      !browsing &&
      !root.current?.contains(document.activeElement) &&
      !root.current?.matches(':hover')
    ) {
      setHeld(null)
      setActive(null)
    }
  }
  const scrollTo = (index: number) => {
    setBrowsing(true)
    hold()
    const target = Math.max(0, Math.min(index, items.length - 1))
    if (small && viewport.current) {
      viewport.current.scrollTop =
        viewport.current.querySelector<HTMLElement>(`[data-index="${target}"]`)?.offsetTop ?? 0
    } else {
      virtual.scrollToIndex(target, { align: 'start' })
    }
    requestAnimationFrame(measure)
  }
  const scrollHandlers = useWorkerDockScroll({
    small,
    viewport,
    virtual,
    items,
    anchor,
    measure,
    hold,
    setBrowsing,
    scrollTo
  })
  if (!total && !identities.length && !props.incomplete) {
    return null
  }
  return (
    <div
      ref={root}
      data-native-chat-background-tasks="true"
      className="min-w-0 text-xs text-muted-foreground"
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
          setFocused(row.dataset.workerDockRow ?? null)
          row.scrollIntoView({ block: 'nearest' })
        }
      }}
      onBlurCapture={() =>
        queueMicrotask(() => {
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
        total={total}
        failures={failures}
        clearUnavailable={clearUnavailable}
        clearing={clearing}
        listId={id}
        summary={summary}
        onToggle={() => {
          setHeld(null)
          setBrowsing(false)
          props.onExpandedChange(!props.expanded)
        }}
        onClear={props.onClearAll}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {count}
      </span>
      {props.expanded ? (
        <>
          {orderHeld ? (
            <div className="flex h-7 items-center justify-between px-4 text-xs">
              <span>Order held</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setHeld(null)
                  setBrowsing(false)
                  virtual.scrollToOffset(0)
                }}
              >
                Show latest
              </Button>
            </div>
          ) : null}
          <div
            ref={viewport}
            id={id}
            role="region"
            aria-label={more ? 'Workers · more workers below' : 'Workers'}
            tabIndex={0}
            className="scrollbar-sleek overflow-y-auto border-t border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ height }}
            onScroll={scrollHandlers.onScroll}
            onKeyDown={scrollHandlers.onKeyDown}
          >
            <div
              style={{
                height: small ? 'auto' : virtual.getTotalSize() + height,
                position: 'relative'
              }}
            >
              {visibleItems.map((item) => {
                const identity = items[item.index]
                const row = props.rows.get(identity.id) ?? cached.current.get(identity.id)
                const retired = !current.has(identity.id)
                return (
                  <WorkerDockItem
                    key={identity.id}
                    index={item.index}
                    identity={identity}
                    row={row}
                    retired={retired}
                    small={small}
                    start={item.start}
                    measure={virtual.measureElement}
                    narrow={props.narrow}
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
          {more ? (
            <div className="flex h-6 items-center justify-center bg-gradient-to-b from-muted/30 to-muted text-2xs">
              More below
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
