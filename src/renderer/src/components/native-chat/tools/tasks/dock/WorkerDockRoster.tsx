import { useTranslate } from '@/i18n/use-translate'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { useNativeChatToolRunWindow } from '../../runs/use-native-chat-tool-run-window'
import { workerDockClearable } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { workerDockRowTitle, type WorkerDockRowView } from './WorkerDockRow'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { cn } from '@/lib/class-names'
import {
  workerDockChipLabel,
  workerDockHeading,
  workerDockNamedCounts,
  workerDockSummary
} from './worker-dock-summary'
import {
  workerDockEmptyCopy,
  workerDockRegionLabel,
  workerDockSpokenTitle
} from './worker-dock-labels'
import { workerDockGlyph } from './worker-dock-card-order'
import {
  workerDockAnchorIndex,
  workerDockRowKeyTarget,
  workerDockScrollAnchorAt,
  workerDockScrollFade,
  type WorkerDockScrollAnchor
} from './worker-dock-scroll-anchor'
import { WorkerDockCardFooter } from './WorkerDockCardFooter'
import {
  useWorkerDockGroupedOrder,
  workerDockStopAllScope,
  workerDockTopRow,
  type WorkerDockIdentity
} from './worker-dock-groups'
import { WorkerDockGroupedRows } from './WorkerDockGroupedRows'
import { useWorkerDockFooterFocus } from './use-worker-dock-footer-focus'
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
  const anchor = useRef<WorkerDockScrollAnchor | null>(null)
  const {
    sorted,
    items,
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
  const { mixed, total, count, label, failures } = summary
  const smallRoster = items.length <= 30
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
    enabled: props.expanded && !smallRoster
  })
  const small = rowWindow.drawsEveryRow
  const virtual = rowWindow.virtualizer
  const visibleItems = rowWindow.drawn
  const [fade, setFade] = useState<string | undefined>(undefined)
  const refade = useLatestHandler(() =>
    setFade(viewport.current ? workerDockScrollFade(viewport.current) : undefined)
  )
  const budget = useWorkerDockCardBudget({
    root,
    pill,
    card,
    open: props.expanded,
    rows: items.length
  })
  // Re-read after the list's size changes; scrolling re-reads it from onScroll.
  useLayoutEffect(() => refade(), [refade, props.expanded, items.length, budget])
  // With no rows, the pill says only what is known: the provider reports work it does not list,
  // or the worker read failed (which claims nothing about whether anything runs).
  const unlisted = items.length === 0 && Boolean(props.incomplete)
  const unread = items.length === 0 && !unlisted && Boolean(props.unavailable)
  const shown = items.length > 0 || unlisted || unread
  const close = useLatestHandler((refocus: boolean) => {
    setHeld(null)
    props.onExpandedChange(false)
    if (refocus) {
      pill.current?.focus()
    }
  })
  useWorkerDockOutsidePress(root, props.expanded, () => close(false))
  useWorkerDockJumpLift(card, props.expanded)
  const top = useMemo(
    () => workerDockTopRow(props.identities, props.rows),
    [props.identities, props.rows]
  )
  const topRow = top ? props.rows.get(top.id) : undefined
  // The pill names a worker the host has not sent yet; ask for the window around it.
  const loadWindow = useWorkerDockDetailReads(props.identities, props.loadWindow)
  const missingTop = top && !topRow ? top.id : null
  useEffect(() => {
    if (missingTop) {
      loadWindow(missingTop)
    }
  }, [missingTop, loadWindow])
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
  const identityOrder = items.map((row) => row.id).join('|')
  useLayoutEffect(preserveAnchor, [identityOrder, props.rows, preserveAnchor])
  const hold = () => setHeld((previous) => previous ?? sorted)
  const release = () => {
    if (!root.current?.contains(document.activeElement) && !root.current?.matches(':hover')) {
      setHeld(null)
    }
  }
  useWorkerDockFooterFocus(
    root,
    pill,
    `${shown && props.expanded}:${Boolean(props.stopAll)}:${clearable >= 2}`
  )
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
  if (!shown) {
    return null
  }
  const chipLabel = workerDockChipLabel(t, {
    summary: { total, failures, label },
    rows: itemCounts,
    empty: top ? null : workerDockEmptyCopy(t, unlisted).title
  })
  // With live counts the spoken chip names both groups in full; a held or failed chip says its own text.
  const named = workerDockNamedCounts(t, summary, itemCounts)
  const chipSpoken = chipLabel === named.label && named.spoken ? named.spoken : chipLabel
  const stopAllScope = workerDockStopAllScope(items, props.rows)
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
        className={cn(
          'absolute bottom-0 left-0 flex flex-col [[data-native-chat-dock-fit~=dock]_&]:static',
          props.expanded
            ? cn(WORKER_DOCK_SURFACE_CLASS, 'right-0 gap-1 rounded-[10px] p-1 shadow-floating')
            : 'pointer-events-none max-w-full self-start'
        )}
        onPointerEnter={props.expanded ? hold : undefined}
        onPointerLeave={release}
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
            top
              ? workerDockGlyph({ ...top, retired: topRow?.retired })
              : unlisted
                ? 'running'
                : 'queued'
          }
          label={chipLabel}
          spokenLabel={chipSpoken}
          latest={topRow ? workerDockSpokenTitle(topRow.kind, workerDockRowTitle(topRow)) : count}
          total={named.total}
          heading={workerDockHeading(t, named)}
          commandsOnly={named.commands > 0 && named.workers === 0}
          expanded={props.expanded}
          listId={id}
          onToggle={() => {
            setHeld(null)
            // The panel opens under a pointer already inside its box, so no pointerenter follows.
            if (!props.expanded && root.current?.matches(':hover')) {
              hold()
            }
            props.onExpandedChange(!props.expanded)
          }}
          onKeyDown={(event) => {
            if (
              props.expanded &&
              items.length &&
              (event.key === 'ArrowUp' || event.key === 'ArrowDown')
            ) {
              event.preventDefault()
              focusRow(event.key === 'ArrowUp' ? items.length - 1 : 0)
            }
          }}
        />
        {props.expanded ? (
          <>
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
                const row =
                  event.target instanceof Element
                    ? event.target.closest<HTMLElement>('[data-worker-dock-row]')
                    : null
                const index = items.findIndex((item) => item.id === row?.dataset.workerDockRow)
                const next =
                  index === -1 ? null : workerDockRowKeyTarget(event.key, index, items.length)
                if (next === null) {
                  return
                }
                event.preventDefault()
                // The header sits above the first row, so moving up past it lands there.
                if (event.key === 'ArrowUp' && index === 0) {
                  pill.current?.focus()
                } else {
                  focusRow(Math.min(next, items.length - 1))
                }
              }}
            >
              <div style={{ height: small ? 'auto' : rowWindow.totalSize, position: 'relative' }}>
                <WorkerDockGroupedRows
                  items={items}
                  drawn={visibleItems}
                  agentRows={itemCounts.workers}
                  grouped={itemCounts.workers > 0 && itemCounts.commands > 0}
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
            <WorkerDockCardFooter
              stopAll={props.stopAll}
              stopAllScope={stopAllScope}
              clearable={clearable}
              // A failed command Clear leaves behind: the button then says it clears workers.
              namesWorkers={items.some(
                (row) =>
                  isCommand(row) &&
                  (row.state === 'failed' || row.state === 'unexpected') &&
                  !workerDockClearable(row)
              )}
              clearing={clearing}
              onClearAll={() => {
                props.onClearAll()
                pill.current?.focus()
              }}
            />
          </>
        ) : null}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {count || chipSpoken}
      </span>
    </div>
  )
}
