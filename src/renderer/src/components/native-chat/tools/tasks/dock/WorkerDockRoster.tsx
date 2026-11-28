import { useTranslate } from '@/i18n/use-translate'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { useNativeChatToolRunWindow } from '../../runs/use-native-chat-tool-run-window'
import { workerDockClearable } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { workerDockRowTitle, type WorkerDockRowView } from './WorkerDockRow'
import { WorkerDockGroupedRows } from './WorkerDockGroupedRows'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { cn } from '@/lib/class-names'
import { workerDockChip, workerDockSummary } from './worker-dock-summary'
import {
  workerDockEmptyCopy,
  workerDockIsAgentKind,
  workerDockRegionLabel,
  workerDockSpokenTitle
} from './worker-dock-labels'
import { workerDockGlyph } from './worker-dock-card-order'
import {
  useWorkerDockGroupedOrder,
  workerDockClearNamesWorkers,
  workerDockStopAllScope,
  useWorkerDockTop,
  type WorkerDockIdentity
} from './worker-dock-groups'
import { useWorkerDockFooterFocus } from './use-worker-dock-footer-focus'
import {
  workerDockAnchorIndex,
  workerDockListKeyTarget,
  workerDockScrollAnchorAt,
  workerDockScrollFade,
  type WorkerDockScrollAnchor
} from './worker-dock-scroll-anchor'
import { WorkerDockHeadActions } from './WorkerDockHeadActions'
import { useWorkerDockCardFocus } from './use-worker-dock-card-focus'
import { useWorkerDockCardBudget, WORKER_DOCK_ROW } from './use-worker-dock-card-budget'
import { useWorkerDockDetailReads } from './use-worker-dock-detail-reads'
import {
  WORKER_DOCK_FLOAT_CLASS,
  WORKER_DOCK_SURFACE_CLASS,
  WorkerDockPill,
  useWorkerDockJumpLift,
  useWorkerDockOutsidePress
} from './WorkerDockPill'
import { useWorkerDockHover, useWorkerDockMorph } from './use-worker-dock-morph'
import { useWorkerChipPlacement } from './worker-chip-slot'
import './worker-dock-morph.css'

type Identity = WorkerDockIdentity

/** The chat's open workers as one floating pill over the end of the transcript; pressing it opens
 *  a card of every worker above it. Nothing is drawn behind either, so the chat stays readable. */
export function WorkerDockRoster(props: {
  identities: readonly Identity[]
  countIdentities?: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[]
  rows: ReadonlyMap<string, WorkerDockRowView>
  visible: boolean
  /** Some running work is not listed: with no rows the pill still shows, so Stop all stays reachable. */
  incomplete?: boolean
  /** The worker read failed, so the rows (if any) cannot be trusted to be the whole roster. */
  unavailable?: boolean
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
  const pill = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const anchor = useRef<WorkerDockScrollAnchor | null>(null)
  const {
    sorted,
    items,
    holding,
    setHeld,
    isCommand,
    counts: itemCounts
  } = useWorkerDockGroupedOrder(props.identities, props.rows)
  const [focused, setFocused] = useState<string | null>(null)
  const clearing = props.identities.some(
    (row) => workerDockClearable(row) && props.pending.has(row.id)
  )
  const clearable = props.identities.filter(workerDockClearable).length
  const summary = workerDockSummary(props.countIdentities ?? props.identities, props.rows, t)
  const { mixed, count, needsYou } = summary
  const smallRoster = items.length <= 30
  // With no rows, the pill says only what is known: the provider reports work it does not list,
  // or the worker read failed (which claims nothing about whether anything runs).
  const unlisted = items.length === 0 && Boolean(props.incomplete)
  const unread = items.length === 0 && !unlisted && Boolean(props.unavailable)
  const shown = items.length > 0 || unlisted || unread
  const morph = useWorkerDockMorph({
    card,
    shown,
    expanded: props.expanded,
    counts: [count, needsYou],
    workers: sorted,
    rows: props.rows
  })
  const activeIndex = useMemo(() => items.findIndex((row) => row.id === focused), [items, focused])
  const rowKeys = useMemo(() => items.map((item) => ({ key: item.id })), [items])
  const estimateSize = useCallback(() => WORKER_DOCK_ROW, [])
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
    getScrollElement: () => viewport.current,
    isVisible: props.visible,
    drawsEveryRow: smallRoster,
    estimateSize,
    rangeExtractor: extractRange,
    enabled: morph.mounted && !smallRoster
  })
  const small = rowWindow.drawsEveryRow
  const virtual = rowWindow.virtualizer
  const visibleItems = rowWindow.drawn
  const [fade, setFade] = useState<string | undefined>(undefined)
  const refade = useLatestHandler(() =>
    setFade(viewport.current ? workerDockScrollFade(viewport.current) : undefined)
  )
  const placement = useWorkerChipPlacement()
  const budget = useWorkerDockCardBudget({
    root,
    card,
    // Until the fold ends: Jump to latest stays lifted (or set aside) while the card still covers it.
    open: shown && morph.mounted,
    dropped: props.expanded,
    rows: items.length,
    placement
  })
  // Re-read after the list's size changes and once the rising rows land (they overflow it while they
  // rise); scrolling re-reads it from onScroll.
  useLayoutEffect(() => refade(), [refade, props.expanded, items.length, budget, morph.entering])
  // The folding rows keep their order until they are gone.
  if (holding && !morph.mounted) {
    setHeld(null)
  }
  const close = useLatestHandler((refocus: boolean) => {
    props.onExpandedChange(false)
    if (refocus) {
      pill.current?.focus()
    }
  })
  useWorkerDockOutsidePress(root, props.expanded, () => close(false))
  useWorkerDockJumpLift({ root, card, content, shown, open: morph.mounted, placement })
  const loadWindow = useWorkerDockDetailReads(props.identities, props.loadWindow)
  const { top, topRow } = useWorkerDockTop(props.identities, props.rows, loadWindow)
  // Ask for the details of the first row in view that has none. Not the first drawn row: a focused
  // row stays drawn after End, and the card's order (needs-you first) is not the host's.
  const loadVisibleWindow = useLatestHandler(() => {
    const element = viewport.current
    if (!element || !props.expanded) {
      return
    }
    const top = element.scrollTop
    const bottom = top + element.clientHeight
    const missing = visibleItems.find(
      (item) =>
        item.end > top &&
        item.start < bottom &&
        items[item.index] &&
        !props.rows.has(items[item.index].id)
    )
    if (missing) {
      loadWindow(items[missing.index].id)
    }
  })
  const drawnKey = visibleItems.map((item) => item.index).join(',')
  useEffect(loadVisibleWindow, [drawnKey, props.rows, props.expanded, loadVisibleWindow])
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
  const itemIds = useMemo(() => items.map((row) => row.id), [items])
  const identityOrder = itemIds.join('|')
  useLayoutEffect(preserveAnchor, [identityOrder, props.rows, preserveAnchor])
  const hold = () => setHeld((previous) => previous ?? sorted)
  const release = () => {
    if (!root.current?.contains(document.activeElement) && !root.current?.matches(':hover')) {
      setHeld(null)
    }
  }
  const drawnActions = `${shown && props.expanded}:${Boolean(props.stopAll)}:${clearable >= 2}`
  useWorkerDockFooterFocus(root, pill, shown, drawnActions)
  const { focusRow, rememberFocus, forgetFocus } = useWorkerDockCardFocus({
    items,
    rows: props.rows,
    loadRow: loadWindow,
    small,
    virtual,
    viewport,
    pill,
    hold
  })
  const hover = useWorkerDockHover({
    root,
    card,
    expanded: props.expanded,
    onOpen: () => {
      // The list opens under the pointer, so its order holds from the start.
      setHeld(sorted)
      props.onExpandedChange(true)
    },
    onClose: () => close(false),
    onEnter: () => props.expanded && hold(),
    onLeave: release
  })
  if (!shown) {
    return null
  }
  const chip = workerDockChip(t, {
    summary,
    rows: itemCounts,
    empty: top ? null : workerDockEmptyCopy(t, unlisted).title,
    single: topRow && workerDockIsAgentKind(topRow.kind) ? workerDockRowTitle(topRow) : null,
    open: props.expanded
  })
  const named = chip.named
  return (
    <div
      ref={root}
      data-native-chat-background-tasks="true"
      data-worker-dock-float=""
      className={WORKER_DOCK_FLOAT_CLASS}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && props.expanded) {
          event.preventDefault()
          event.stopPropagation()
          close(true)
        }
      }}
    >
      {/* One box for the chip and the open panel, so the chip turns into the panel's header in
          place and keeps focus. */}
      <div
        ref={card}
        data-worker-dock-card={props.expanded ? '' : undefined}
        data-worker-dock-morph={props.expanded ? 'open' : 'closed'}
        data-worker-dock-entering={morph.entering ? '' : undefined}
        className={cn(
          WORKER_DOCK_SURFACE_CLASS,
          'absolute inset-x-0 bottom-0 z-20 mx-auto flex max-w-full flex-col overflow-hidden',
          'rounded-xl',
          props.expanded ? 'shadow-floating' : 'shadow-sm'
        )}
        onPointerEnter={hover.enter}
        onPointerLeave={hover.leave}
        onPointerDownCapture={hover.pressCapture}
        onClickCapture={hover.clickCapture}
        onFocusCapture={(event) => {
          // Only the open panel holds its order; the folded chip has none to keep still.
          if (props.expanded) {
            hold()
          }
          const row =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-worker-dock-row]')
              : null
          if (row) {
            const rowId = row.dataset.workerDockRow ?? null
            setFocused(rowId)
            if (rowId) {
              rememberFocus(rowId, row.closest('[data-native-chat-root]'))
            }
            row.scrollIntoView({ block: 'nearest' })
          }
        }}
        onBlurCapture={() =>
          queueMicrotask(() => {
            if (!root.current?.contains(document.activeElement)) {
              forgetFocus()
            }
            setFocused(
              document.activeElement?.closest<HTMLElement>('[data-worker-dock-row]')?.dataset
                .workerDockRow ?? null
            )
            release()
          })
        }
      >
        <WorkerDockPill
          pill={pill}
          glyph={
            top ? workerDockGlyph({ ...top, retired: topRow?.retired }) : unlisted && 'running'
          }
          label={chip.label}
          titled={chip.titled}
          spokenLabel={chip.spoken}
          commandsOnly={named.commands > 0 && named.workers === 0}
          latest={topRow ? workerDockSpokenTitle(topRow.kind, workerDockRowTitle(topRow)) : count}
          total={named.total}
          expanded={props.expanded}
          listId={id}
          action={
            <WorkerDockHeadActions
              stopAll={props.stopAll}
              stopAllScope={workerDockStopAllScope(items, props.rows)}
              clearable={clearable}
              namesWorkers={workerDockClearNamesWorkers(items, isCommand)}
              clearing={clearing}
              onClearAll={() => {
                props.onClearAll()
                pill.current?.focus()
              }}
            />
          }
          onToggle={(event) => {
            // A press on a chip the pointer opened pins it open instead of folding it.
            if (hover.pin(event)) {
              return
            }
            // Opening under a pointer already inside the box (no pointerenter follows) holds the
            // order at once; folding keeps it until the rows are gone.
            if (!props.expanded) {
              setHeld(root.current?.matches(':hover') ? sorted : null)
            }
            props.onExpandedChange(!props.expanded)
          }}
          onEnterList={() => items.length > 0 && focusRow(0)}
        />
        <div data-worker-dock-clip="">
          {/* Folding, the rows still draw but take no focus or presses. */}
          <div inert={!props.expanded}>
            {morph.mounted ? (
              <div ref={content} className="flex flex-col p-1">
                <div
                  ref={viewport}
                  id={id}
                  role="region"
                  aria-label={workerDockRegionLabel(t, named.workers, named.commands)}
                  className="scrollbar-sleek min-h-0 overflow-y-auto overscroll-contain"
                  style={{ maxHeight: budget, maskImage: fade }}
                  onScroll={(event) => {
                    anchor.current =
                      workerDockScrollAnchorAt(
                        event.currentTarget,
                        small ? null : virtual.getVirtualItems(),
                        items
                      ) ?? anchor.current
                    hold()
                    loadVisibleWindow()
                    refade()
                  }}
                  onKeyDown={(event) => {
                    const next = workerDockListKeyTarget(event, itemIds)
                    if (next !== null) {
                      event.preventDefault()
                      if (next === 'chip') {
                        pill.current?.focus()
                      } else {
                        focusRow(next)
                      }
                    }
                  }}
                >
                  <div
                    style={{ height: small ? 'auto' : rowWindow.totalSize, position: 'relative' }}
                  >
                    <WorkerDockGroupedRows
                      items={items}
                      drawn={visibleItems}
                      agentRows={itemCounts.workers}
                      grouped={itemCounts.workers > 0 && itemCounts.commands > 0}
                      entering={morph.entering}
                      small={small}
                      measureRow={rowWindow.measureRow}
                      rows={props.rows}
                      mixed={mixed}
                      visible={props.visible}
                      pending={props.pending}
                      onOpen={onOpen}
                      onAction={onAction}
                    />
                  </div>
                  {unlisted || unread ? (
                    <p className="flex h-[30px] items-center px-2 text-xs text-muted-foreground">
                      {workerDockEmptyCopy(t, unlisted).note}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {count || chip.spoken}
      </span>
    </div>
  )
}
