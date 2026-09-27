import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { sidebarGeometryBoundaries, type SidebarGeometry } from '../listing/sidebar-geometry-slots'
import {
  sidebarGeometryTopologyMatches,
  type SidebarGeometryLedger
} from './sidebar-geometry-ledger'
import {
  resolveSidebarCorrectionTarget,
  type SidebarGeometryCorrection,
  type SidebarScrollRounding
} from './sidebar-geometry-commit'

export function createSidebarLayoutCorrection(args: {
  previous: SidebarGeometry | null
  model: SidebarGeometry
  ledger: SidebarGeometryLedger
  anchor: VirtualizedScrollAnchor
  pending: SidebarGeometryCorrection | null
  rounding: SidebarScrollRounding | null
  physicalOffset: number
  epoch: number
  inset: number
}): SidebarGeometryCorrection | null {
  const { previous, model, ledger, pending, rounding, physicalOffset, epoch, inset } = args
  const anchor = pending?.anchor ?? args.anchor
  if (
    !previous ||
    !anchor ||
    !sidebarGeometryTopologyMatches(previous, model) ||
    (pending &&
      (pending.epoch !== epoch ||
        pending.navigation ||
        (pending.anchor && !pending.layoutAnchor) ||
        pending.sourceOffset !== physicalOffset))
  ) {
    return null
  }
  const index = previous.nodeByKey.get(anchor.key)
  if (index === undefined) {
    return null
  }
  const boundaries = sidebarGeometryBoundaries(previous, ledger.sizes)
  const remainder =
    rounding?.epoch === epoch && rounding.offset === physicalOffset ? rounding.remainder : 0
  const logicalOffset = pending
    ? resolveSidebarCorrectionTarget(pending, previous, boundaries, inset, physicalOffset)
    : physicalOffset + remainder
  return {
    target: 0,
    epoch,
    sourceOffset: physicalOffset,
    layoutAnchor: true,
    anchor: { ...anchor, offset: logicalOffset - boundaries[previous.nodes[index]!.slot]! - inset }
  }
}
