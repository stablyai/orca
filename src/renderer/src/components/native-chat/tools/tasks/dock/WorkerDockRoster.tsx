import { useTranslate } from '@/i18n/use-translate'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { useNativeChatToolRunWindow } from '../../runs/use-native-chat-tool-run-window'
import { Button } from '@/components/ui/button'
import { workerDockNeedsAttention } from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { WorkerDockRowView } from './WorkerDockRow'
import { WorkerDockItem } from './WorkerDockItem'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { workerDockSummary } from './worker-dock-summary'
import { WorkerDockHeader } from './WorkerDockHeader'
import { useWorkerDockScroll } from './use-worker-dock-scroll'
import { useWorkerDockRowCache } from './use-worker-dock-row-cache'
import { workerDockAnchorIndex, type WorkerDockScrollAnchor } from './worker-dock-scroll-anchor'
import { useWorkerDockScrollViewport } from './NativeChatWorkerDockFrame'
import { workerDockRosterBudget } from './worker-dock-roster-budget'

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
  const { scroller, scrollMargin } = useWorkerDockScrollViewport(
    viewport,
    props.narrow,
    props.expanded
  )
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
  const [browsing, setBrowsing] = useState(false)
  const cached = useWorkerDockRowCache(props.rows, active, focused)
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
      (row.ownerActionsAvailable === false || cached.get(row.id)?.ownerActionsAvailable === false)
  )
  const { failures } = workerDockSummary(props.identities, cached, t)
  const { mixed, total, count, needsYou } = workerDockSummary(
    props.countIdentities ?? props.identities,
    cached,
    t
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
    scrollerRef: scroller,
    scrollMargin,
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
  const measure = () => {
    const element = viewport.current
    if (!element) {
      return
    }
    const budget = workerDockRosterBudget(root.current, element, props.narrow, orderHeld)
    const measured = small
      ? [...element.querySelectorAll<HTMLElement>('[data-index]')].map((node) => ({
          start: node.offsetTop,
          end: node.offsetTop + node.offsetHeight
        }))
      : virtual.getVirtualItems()
    const start = measured.find((item) => item.end > element.scrollTop + 1)?.start ?? 0
    let end = start
    for (const item of measured) {
      if (item.end <= start + 1) {
        continue
      }
      if (item.end - start > budget && end > start) {
        break
      }
      end = item.end
    }
    const last = element.firstElementChild?.lastElementChild
    const totalSize = small
      ? last instanceof HTMLElement
        ? last.offsetTop + last.offsetHeight
        : 0
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
    const first = visibleItems.find((item) => item.end > (scroller.current?.scrollTop ?? 0))
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
    onAnchorChange: (value) => {
      anchor.current = { ...value, order: items }
    },
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
      className="min-h-0 min-w-0 text-xs text-muted-foreground group-has-[[data-native-chat-worker-approvals]]/worker-dock:contents"
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
        needsYou={needsYou}
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
                  setBrowsing(false)
                  virtual.scrollToOffset(0)
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
            aria-label={
              more
                ? t('components.native-chat.workerDock.workersMore', 'Workers · more workers below')
                : t('components.native-chat.workerDock.workersRegion', 'Workers')
            }
            tabIndex={0}
            className="scrollbar-sleek overflow-y-auto border-t border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-has-[[data-native-chat-worker-approvals]]/worker-dock:h-auto! group-has-[[data-native-chat-worker-approvals]]/worker-dock:overflow-visible"
            style={{ height }}
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
                const row = props.rows.get(identity.id) ?? cached.get(identity.id)
                const retired = !current.has(identity.id)
                return (
                  <WorkerDockItem
                    key={identity.id}
                    index={item.index}
                    identity={identity}
                    row={row}
                    retired={retired}
                    small={small}
                    start={item.start - scrollMargin}
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
          {more && !props.compact ? (
            <div className="flex h-6 items-center justify-center bg-gradient-to-b from-muted/30 to-muted text-2xs group-has-[[data-native-chat-worker-approvals]]/worker-dock:hidden">
              {t('components.native-chat.workerDock.moreBelow', 'More below')}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
