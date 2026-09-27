import type { SidebarCardGeometryResolver } from '../listing/sidebar-card-geometry'
import { useSidebarGeometryCommit } from './use-sidebar-geometry-commit'
import { useReusedArrayIdentity } from '../listing/use-reused-array-identity'
import { scrollSidebarVirtualizer } from './sidebar-scroll-to'
import { selectSidebarViewport } from './sidebar-viewport-selection'
import { publishSidebarMeasurements } from './sidebar-measurement-publication'
import { useCallback, useMemo, useReducer, useRef } from 'react'
import type React from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import {
  type SidebarGeometry,
  buildSidebarGeometry,
  sidebarGeometryBoundaries,
  sidebarSlotContentEnd
} from '../listing/sidebar-geometry-slots'
import { getRenderRowKey, type RenderRow } from '../listing/render-row'
import { getStickyHeaderIndexes } from './virtual-rows'
import { getSidebarGeometryLedger, type SidebarObservation } from './sidebar-geometry-ledger'
import { useSidebarGeometryObserver } from './use-sidebar-geometry-observer'
import {
  clampSidebarOffset,
  getSidebarNavigationTitleEnd,
  resolveSidebarCorrectionTarget,
  sidebarNavigationOffset,
  type SidebarGeometryCorrection,
  type SidebarScrollRounding
} from './sidebar-geometry-commit'
import { useSidebarGeometryAnchor } from './use-sidebar-geometry-anchor'
import {
  USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS,
  type WorktreeSidebarScrollSuppression
} from './use-scroll-suppression'
import { WORKTREE_SIDEBAR_REVEAL_TOP_INSET } from '../../worktree-sidebar-reveal'
import type { VirtualizedWorktreeViewportProps } from './viewport-props'
import { useSidebarRowRetention } from './use-sidebar-row-retention'

export type WorktreeListVirtualizer = ReturnType<typeof useWorktreeListVirtualizer>
export function useWorktreeListVirtualizer(args: {
  renderRows: RenderRow[]
  firstHeaderIndex: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  suppression: WorktreeSidebarScrollSuppression
  newCardStyle: boolean
  layoutContext?: string
  resolveCardGeometry?: SidebarCardGeometryResolver
  props: Pick<
    VirtualizedWorktreeViewportProps,
    | 'activeWorktreeId'
    | 'activeWorkspaceExecutionHostId'
    | 'pendingRevealWorktree'
    | 'pendingRevealSidebarRow'
    | 'defaultHostId'
  >
  draggingWorktreeId: string | null
}) {
  const { renderRows, scrollRef, scrollOffsetRef, scrollAnchorRef, suppression } = args
  const model = useMemo(
    () => buildSidebarGeometry(renderRows, args.resolveCardGeometry),
    [renderRows, args.resolveCardGeometry]
  )
  const rootByOuterIndex = useMemo(
    () => new Map(model.roots.map((index) => [model.nodes[index]!.outerIndex, index])),
    [model]
  )
  const semanticRows = useMemo(() => model.nodes.map((node) => node.row), [model])
  const ledger = getSidebarGeometryLedger(scrollAnchorRef)
  const [, renderConverged] = useReducer((n: number) => n + 1, 0)
  const publishedRevision = useRef(0)
  const [revision, observationChanged] = useReducer((n: number) => n + 1, 0)
  const changed = () => {
    publishedRevision.current++
    observationChanged()
  }
  const publishedModel = useRef<SidebarGeometry | null>(null)
  const correction = useRef<SidebarGeometryCorrection | null>(null)
  const rounding = useRef<SidebarScrollRounding | null>(null)
  const insetRef = useRef(1)
  const publication = useMemo(() => ({ revision, sizes: ledger.sizes }), [revision, ledger])
  const boundaries = useMemo(
    () => sidebarGeometryBoundaries(model, publication.sizes),
    [model, publication]
  )
  const total = boundaries.at(-1)!
  const viewport = scrollRef.current?.clientHeight ?? 0
  const offset = scrollRef.current?.scrollTop ?? scrollOffsetRef.current
  const renderedCorrection = correction.current
  let target =
    correction.current?.epoch === suppression.scrollOwnershipEpochRef.current
      ? resolveSidebarCorrectionTarget(
          correction.current,
          model,
          boundaries,
          insetRef.current,
          offset
        )
      : offset
  const navigation =
    renderedCorrection?.epoch === suppression.scrollOwnershipEpochRef.current
      ? renderedCorrection.navigation
      : undefined
  if (navigation) {
    const index = model.nodeByKey.get(navigation.key)
    if (index !== undefined) {
      const node = model.nodes[index]!
      const start = boundaries[node.slot]! + insetRef.current
      target = sidebarNavigationOffset(
        start,
        sidebarSlotContentEnd(model, boundaries, node.end - 1) + insetRef.current,
        offset,
        viewport,
        node.revealTopInset,
        navigation.align,
        getSidebarNavigationTitleEnd(scrollRef.current, node.row, start)
      )
    }
  }
  const stickyHeaderIndexes = useMemo(() => getStickyHeaderIndexes(renderRows), [renderRows])
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const activeStickyHostIndexRef = useRef<number | null>(null)
  const { targets: targetNodes, retainInteraction: retainFocusedRow } = useSidebarRowRetention({
    model,
    ...args.props,
    draggingWorktreeId: args.draggingWorktreeId
  })
  const {
    selected,
    slots: selectedSlots,
    outerStart
  } = selectSidebarViewport({
    model,
    boundaries,
    rows: renderRows,
    offset,
    target: clampSidebarOffset(target, total, viewport, insetRef.current),
    viewport,
    inset: insetRef.current,
    targets: targetNodes,
    stickyHeaderIndexes,
    rootByOuterIndex
  })
  const stableSlots = useReusedArrayIdentity(selectedSlots)
  const rangeExtractor = useCallback(() => stableSlots, [stableSlots])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: model.slots.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: useCallback((index: number) => model.slots[index]!.key, [model]),
    estimateSize: (index) => boundaries[index + 1]! - boundaries[index]!,
    rangeExtractor,
    overscan: 0,
    gap: 0,
    initialOffset: () => scrollOffsetRef.current,
    scrollPaddingStart: WORKTREE_SIDEBAR_REVEAL_TOP_INSET,
    isScrollingResetDelay: USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS,
    useFlushSync: false,
    scrollToFn: scrollSidebarVirtualizer
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  const retainedItems: VirtualItem[] = [...selected]
    .sort((a, b) => a - b)
    .map((index) => {
      const node = model.nodes[index]!
      return {
        index,
        key: node.key,
        lane: 0,
        start: boundaries[node.slot]! + insetRef.current,
        end: sidebarSlotContentEnd(model, boundaries, node.slot) + insetRef.current,
        size: sidebarSlotContentEnd(model, boundaries, node.slot) - boundaries[node.slot]!
      }
    })
  const outerItems: VirtualItem[] = [...selected]
    .filter((index) => model.nodes[index]!.parent === null)
    .sort((a, b) => a - b)
    .map((index) => {
      const node = model.nodes[index]!
      return {
        index: node.outerIndex,
        key:
          node.row.type === 'folder-workspace'
            ? node.key
            : getRenderRowKey(renderRows[node.outerIndex]!),
        lane: 0,
        start: boundaries[node.slot]!,
        end: sidebarSlotContentEnd(model, boundaries, node.end - 1),
        size: boundaries[node.end]! - boundaries[node.slot]! - node.gap
      }
    })
  const publish = (
    samples: ReadonlyMap<string, SidebarObservation>,
    width: number,
    native: boolean
  ) =>
    publishSidebarMeasurements(
      {
        model,
        publishedModel,
        ledger,
        boundaries,
        scrollAnchorRef,
        scrollRef,
        correction,
        rounding,
        suppression,
        insetRef,
        offset,
        virtualizer,
        changed,
        newCardStyle: args.newCardStyle,
        layoutContext: args.layoutContext
      },
      samples,
      width,
      native
    )
  useSidebarGeometryObserver({ scrollRef, model, publish })
  useSidebarGeometryCommit({
    selectedSlots,
    scrollRef,
    insetRef,
    model,
    scrollOffsetRef,
    correction,
    rounding,
    suppression,
    boundaries,
    virtualizer,
    renderConverged,
    renderedCorrection,
    publishedRevision,
    revision,
    total,
    target
  })
  useSidebarGeometryAnchor({
    model,
    boundaries,
    retained: selected,
    scrollRef,
    anchorRef: scrollAnchorRef,
    scrollOffsetRef,
    inset: insetRef.current,
    canCapture: () => !correction.current && publishedRevision.current === revision
  })
  const navigationVirtualizer = useMemo(
    () => ({
      scrollToIndex: (index: number, options?: Parameters<typeof virtualizer.scrollToIndex>[1]) => {
        const node = model.nodes[index]
        if (!node) {
          return
        }
        rounding.current = null
        correction.current = {
          target: 0,
          epoch: suppression.scrollOwnershipEpochRef.current,
          navigation: {
            key: node.key,
            align: options?.align ?? 'auto',
            behavior: options?.behavior ?? 'auto'
          }
        }
        renderConverged()
      }
    }),
    [model, suppression.scrollOwnershipEpochRef]
  )
  const measureVirtualRowElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        return
      }
      const index = Number(element.dataset.index)
      const root = rootByOuterIndex.get(index)
      if (root !== undefined) {
        element.dataset.sidebarGeometryNode = model.nodes[root]!.key
        element.dataset.sidebarRevealTopInset = String(model.nodes[root]!.revealTopInset)
      }
    },
    [model, rootByOuterIndex]
  )
  return {
    virtualizer,
    navigationVirtualizer,
    semanticRows,
    retainedItems,
    outerItems,
    total,
    presentationOffset: clampSidebarOffset(target, total, viewport, insetRef.current),
    model,
    boundaries,
    selected,
    retainFocusedRow,
    measureVirtualRowElement,
    stickyHeaderIndexes,
    activeStickyHeaderIndexRef,
    activeStickyHostIndexRef,
    rangeStartIndex: outerStart
  }
}
