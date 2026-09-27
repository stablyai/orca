import { createSidebarLayoutCorrection } from './sidebar-layout-correction'
import { sidebarSlotContentEnd, type SidebarGeometry } from '../listing/sidebar-geometry-slots'
import {
  sidebarGeometryLayoutMatches,
  sidebarGeometryTopologyMatches,
  publishSidebarObservation,
  reconcileSidebarLedger,
  type SidebarGeometryLedger,
  type SidebarObservation
} from './sidebar-geometry-ledger'
import type React from 'react'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { SidebarGeometryCorrection, SidebarScrollRounding } from './sidebar-geometry-commit'
import { publishNativeSidebarGeometry } from './use-sidebar-geometry-observer'
import type { WorktreeSidebarScrollSuppression } from './use-scroll-suppression'
import { shouldAdjustWorktreeSidebarMeasuredRowScroll } from './use-scroll-suppression'

export function applySidebarMeasurements(args: {
  model: SidebarGeometry
  ledger: SidebarGeometryLedger
  boundaries: readonly number[]
  samples: ReadonlyMap<string, SidebarObservation>
  inset: number
  scrollOffset: number
  now: number
  suppressUntil: number
  isScrolling: boolean
  scrollDirection: 'forward' | 'backward' | null
  anchorOuterIndex?: number
  skipAnchorRestore?: boolean
  previouslyObserved?: ReadonlySet<string>
}): { changed: boolean; delta: number } {
  let changed = false
  let delta = 0
  for (const [key, observation] of args.samples) {
    const index = args.model.nodeByKey.get(key)
    if (index === undefined) {
      continue
    }
    const node = args.model.nodes[index]!
    if (node.row.type === 'header' || node.row.type === 'host-header') {
      continue
    }
    if ((node.close !== null) !== (observation.closing !== null)) {
      continue
    }
    const changes: [number, number][] = [
      [node.slot, observation.prefix + (node.close === null ? node.gap : 0)]
    ]
    if (node.close !== null && observation.closing !== null) {
      changes.push([node.close, observation.closing + node.gap])
    }
    for (const [slotIndex, size] of changes) {
      const slot = args.model.slots[slotIndex]!
      const previousSize =
        args.ledger.sizes.get(slot.key) ??
        args.boundaries[slotIndex + 1]! - args.boundaries[slotIndex]!
      if (
        (!args.skipAnchorRestore &&
          args.anchorOuterIndex !== undefined &&
          node.outerIndex < args.anchorOuterIndex) ||
        shouldAdjustWorktreeSidebarMeasuredRowScroll({
          isScrolling: args.isScrolling,
          now: args.now,
          suppressUntil: args.suppressUntil,
          itemStart: args.boundaries[slotIndex]! + args.inset,
          itemEnd: sidebarSlotContentEnd(args.model, args.boundaries, slotIndex) + args.inset,
          scrollOffset: args.scrollOffset,
          isFirstMeasurement: !(args.previouslyObserved ?? args.ledger.observed).has(slot.key),
          scrollDirection: args.scrollDirection
        })
      ) {
        delta += size - previousSize
      }
    }
    changed = publishSidebarObservation(args.ledger, args.model, index, observation) || changed
  }
  return { changed, delta }
}

export function publishSidebarMeasurements(
  args: {
    publishedModel: React.MutableRefObject<SidebarGeometry | null>
    model: SidebarGeometry
    ledger: SidebarGeometryLedger
    boundaries: readonly number[]
    newCardStyle: boolean
    layoutContext?: string
    scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
    scrollRef: React.RefObject<HTMLDivElement | null>
    correction: React.MutableRefObject<SidebarGeometryCorrection | null>
    rounding: React.MutableRefObject<SidebarScrollRounding | null>
    suppression: WorktreeSidebarScrollSuppression
    insetRef: React.MutableRefObject<number>
    offset: number
    virtualizer: { isScrolling: boolean; scrollDirection: 'forward' | 'backward' | null }
    changed: () => void
  },
  samples: ReadonlyMap<string, SidebarObservation>,
  width: number,
  native: boolean
): void {
  const {
    model,
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
    changed
  } = args
  const invalidatedLayout =
    ledger.width !== width ||
    ledger.style !== args.newCardStyle ||
    ledger.layoutContext !== (args.layoutContext ?? '')
  const physicalOffset = scrollRef.current?.scrollTop ?? offset
  if (
    invalidatedLayout ||
    rounding.current?.epoch !== suppression.scrollOwnershipEpochRef.current ||
    rounding.current?.offset !== physicalOffset ||
    (correction.current?.anchor && !correction.current.layoutAnchor) ||
    correction.current?.navigation
  ) {
    rounding.current = null
  }
  if (
    invalidatedLayout &&
    scrollAnchorRef.current &&
    !correction.current?.navigation &&
    !suppression.shouldSkipScrollAnchorRestore()
  ) {
    correction.current = {
      target: 0,
      anchor: scrollAnchorRef.current,
      epoch: suppression.scrollOwnershipEpochRef.current
    }
  }
  const previousModel = args.publishedModel.current
  const modelChanged = previousModel !== model
  const previouslyObserved =
    modelChanged && !invalidatedLayout && sidebarGeometryTopologyMatches(previousModel, model)
      ? new Set(ledger.observed)
      : undefined
  if (modelChanged) {
    const layoutChanged = !sidebarGeometryLayoutMatches(previousModel, model)
    if (layoutChanged) {
      const pending = correction.current
      const anchor =
        pending?.epoch === suppression.scrollOwnershipEpochRef.current
          ? (pending.anchor ?? scrollAnchorRef.current)
          : scrollAnchorRef.current
      const layoutCorrection =
        !invalidatedLayout &&
        createSidebarLayoutCorrection({
          previous: previousModel,
          model,
          ledger,
          anchor,
          pending: correction.current,
          rounding: rounding.current,
          physicalOffset,
          epoch: suppression.scrollOwnershipEpochRef.current,
          inset: insetRef.current
        })
      rounding.current = null
      if (
        anchor &&
        !correction.current?.navigation &&
        !suppression.shouldSkipScrollAnchorRestore()
      ) {
        correction.current = layoutCorrection || {
          target: 0,
          anchor,
          epoch: suppression.scrollOwnershipEpochRef.current
        }
      }
    }
    args.publishedModel.current = model
  }
  let updated =
    reconcileSidebarLedger(ledger, model, args.newCardStyle, width, args.layoutContext) ||
    modelChanged
  const anchorIndex = scrollAnchorRef.current
    ? model.nodeByKey.get(scrollAnchorRef.current.key)
    : undefined
  const pending = correction.current
  const effectiveOffset = physicalOffset + (rounding.current?.remainder ?? 0)
  // Mounted destination measurements precede the matching commit's physical scroll.
  const measurementOffset =
    pending &&
    pending.epoch === suppression.scrollOwnershipEpochRef.current &&
    !pending.anchor &&
    !pending.navigation
      ? pending.target
      : effectiveOffset
  const measurement = applySidebarMeasurements({
    model,
    ledger,
    boundaries,
    samples,
    previouslyObserved,
    inset: insetRef.current,
    scrollOffset: measurementOffset,
    now: performance.now(),
    suppressUntil: suppression.suppressMeasurementAdjustmentUntilRef.current,
    isScrolling: virtualizer.isScrolling,
    scrollDirection: virtualizer.scrollDirection,
    anchorOuterIndex: anchorIndex === undefined ? undefined : model.nodes[anchorIndex]!.outerIndex,
    skipAnchorRestore: suppression.shouldSkipScrollAnchorRestore()
  })
  const delta = measurement.delta
  updated = measurement.changed || updated
  if (!updated) {
    return
  }
  if (
    delta !== 0 &&
    !correction.current?.anchor &&
    !correction.current?.navigation &&
    !suppression.shouldSkipScrollAnchorRestore()
  ) {
    correction.current = {
      sourceOffset: physicalOffset,
      target:
        (correction.current?.epoch === suppression.scrollOwnershipEpochRef.current
          ? correction.current.target
          : effectiveOffset) + delta,
      epoch: suppression.scrollOwnershipEpochRef.current
    }
    rounding.current = null
  }
  const publishRevision = () => changed()
  if (native) {
    publishNativeSidebarGeometry(publishRevision)
  } else {
    publishRevision()
  }
}
