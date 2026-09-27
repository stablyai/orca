import { useLayoutEffect, useRef } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { SidebarGeometry } from '../listing/sidebar-geometry-slots'
import { synchronizeSidebarSizes } from './sidebar-size-synchronization'
import {
  sidebarGeometryConverged,
  clampSidebarOffset,
  type SidebarGeometryCorrection,
  type SidebarScrollRounding
} from './sidebar-geometry-commit'
import type { WorktreeSidebarScrollSuppression } from './use-scroll-suppression'

export function useSidebarGeometryCommit(args: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  insetRef: React.MutableRefObject<number>
  model: SidebarGeometry
  scrollOffsetRef: React.MutableRefObject<number>
  correction: React.MutableRefObject<SidebarGeometryCorrection | null>
  rounding: React.MutableRefObject<SidebarScrollRounding | null>
  suppression: WorktreeSidebarScrollSuppression
  selectedSlots: readonly number[]
  boundaries: readonly number[]
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  renderConverged: () => void
  renderedCorrection: SidebarGeometryCorrection | null
  publishedRevision: React.MutableRefObject<number>
  revision: number
  total: number
  target: number
}) {
  const synchronized = useRef(new Map<string, number>())
  const synchronizedBoundaries = useRef<readonly number[] | null>(null)
  // Convergence can require another commit with unchanged boundaries.
  useLayoutEffect(() => {
    const {
      scrollRef,
      insetRef,
      model,
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
      target,
      scrollOffsetRef
    } = args
    const element = scrollRef.current
    if (!element) {
      return
    }
    insetRef.current = Number.parseFloat(getComputedStyle(element).paddingTop) || 0
    if (synchronizedBoundaries.current !== boundaries) {
      synchronizedBoundaries.current = boundaries
      const resized = synchronizeSidebarSizes(model, boundaries, synchronized.current, virtualizer)
      if (resized) {
        renderConverged()
        return
      }
    }
    if (
      !sidebarGeometryConverged(
        model,
        boundaries,
        virtualizer.getVirtualItems(),
        virtualizer.getTotalSize(),
        args.selectedSlots
      )
    ) {
      console.error('Sidebar geometry did not converge; scroll correction withheld')
      correction.current = null
      return
    }
    const pending = correction.current
    if (!pending || pending !== renderedCorrection || publishedRevision.current !== revision) {
      return
    }
    correction.current = null
    rounding.current = null
    if (
      pending.epoch !== suppression.scrollOwnershipEpochRef.current ||
      (!pending.navigation && suppression.shouldSkipScrollAnchorRestore())
    ) {
      return
    }
    const expectedExtent = Math.max(element.clientHeight, Math.round(total + insetRef.current))
    if (Math.abs(element.scrollHeight - expectedExtent) > 1) {
      console.error('Sidebar physical extent disagrees with geometry; correction withheld')
      return
    }
    const destination = clampSidebarOffset(target, total, element.clientHeight, insetRef.current)
    if (pending.navigation || Math.abs(element.scrollTop - destination) > 0.5) {
      virtualizer.scrollToOffset(destination, { behavior: pending.navigation?.behavior })
    }
    scrollOffsetRef.current = element.scrollTop
    const remainder = destination - element.scrollTop
    if (
      (!pending.anchor || pending.layoutAnchor) &&
      !pending.navigation &&
      target === destination &&
      Math.abs(remainder) <= 0.5
    ) {
      // Carry only browser rounding, never an input change or a clamp deficit.
      rounding.current = { offset: element.scrollTop, remainder, epoch: pending.epoch }
    }
    if (
      pending.navigation?.behavior !== 'smooth' &&
      Math.abs(element.scrollTop - destination) > 1
    ) {
      console.error('Sidebar correction was clamped unexpectedly')
    }
  })
}
