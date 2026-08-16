// Why: worktree-level terminal/browser/emulator overlays pin to each group's
// body via CSS anchor positioning. After a pane-column snap Chromium can leave
// the painted box and hit-test box disagreeing (or leave the overlay covering
// chrome that should stay clickable). Measuring the body and correcting the
// overlay is the portable recovery path for Electron, web, and remote hosts.

export type OverlaySlotRect = {
  top: number
  left: number
  width: number
  height: number
}

export const OVERLAY_SLOT_GEOMETRY_MISMATCH_PX = 2
/** Body/overlay smaller than this is treated as not-yet-laid-out, not a desync. */
export const OVERLAY_SLOT_MIN_MEASURABLE_EDGE_PX = 8

function escapeCssAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Locate the tab-group body; prefer worktree-scoped match when available. */
export function findTabGroupBodyElement(
  groupId: string,
  worktreeId?: string
): HTMLElement | null {
  const escapedGroupId = escapeCssAttrValue(groupId)
  if (worktreeId) {
    const escapedWorktreeId = escapeCssAttrValue(worktreeId)
    // Why: never fall through to another worktree's body — hidden worktrees stay mounted.
    return document.querySelector<HTMLElement>(
      `[data-tab-group-body-id="${escapedGroupId}"][data-worktree-id="${escapedWorktreeId}"]`
    )
  }
  return document.querySelector<HTMLElement>(`[data-tab-group-body-id="${escapedGroupId}"]`)
}

export function measureOverlaySlotRect(
  parent: HTMLElement,
  body: HTMLElement
): OverlaySlotRect {
  const parentRect = parent.getBoundingClientRect()
  const bodyRect = body.getBoundingClientRect()
  return {
    top: bodyRect.top - parentRect.top,
    left: bodyRect.left - parentRect.left,
    width: bodyRect.width,
    height: bodyRect.height
  }
}

export function isMeasurableOverlayRect(
  rect: Pick<DOMRect | OverlaySlotRect, 'width' | 'height'>,
  minEdgePx = OVERLAY_SLOT_MIN_MEASURABLE_EDGE_PX
): boolean {
  return rect.width >= minEdgePx && rect.height >= minEdgePx
}

export function isOverlaySlotGeometryMismatched(
  overlayRect: Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>,
  bodyRect: Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>,
  tolerancePx = OVERLAY_SLOT_GEOMETRY_MISMATCH_PX
): boolean {
  return (
    Math.abs(overlayRect.top - bodyRect.top) > tolerancePx ||
    Math.abs(overlayRect.left - bodyRect.left) > tolerancePx ||
    Math.abs(overlayRect.width - bodyRect.width) > tolerancePx ||
    Math.abs(overlayRect.height - bodyRect.height) > tolerancePx
  )
}

export type OverlayGeometryDecision = {
  preferMeasured: boolean
  measured: OverlaySlotRect | null
  /** True when body exists and is large enough to trust for measured layout. */
  bodyMeasurable: boolean
}

/**
 * Decide whether CSS-anchor layout is safe or measured body geometry is required.
 * Viewport getBoundingClientRect comparison detects desync; measured offsets are
 * parent-relative for `position:absolute` top/left/width/height.
 */
export function shouldPreferMeasuredOverlayGeometry(args: {
  overlay: HTMLElement | null
  groupId: string | undefined
  worktreeId?: string
  /** When true, stay on the measured path until the caller resets (e.g. new group). */
  forceMeasured: boolean
  /**
   * When false (hidden/unpainted slot), never latch onto measured from a desync
   * sample — zero-size `display:none` overlays would otherwise false-positive.
   */
  mayLatchDesync: boolean
}): OverlayGeometryDecision {
  if (!args.groupId || !args.overlay) {
    return {
      preferMeasured: args.forceMeasured,
      measured: null,
      bodyMeasurable: false
    }
  }
  const parent = args.overlay.parentElement
  const body = findTabGroupBodyElement(args.groupId, args.worktreeId)
  if (!parent || !body) {
    return {
      preferMeasured: args.forceMeasured,
      measured: null,
      bodyMeasurable: false
    }
  }
  const measured = measureOverlaySlotRect(parent, body)
  const bodyMeasurable = isMeasurableOverlayRect(measured)
  if (args.forceMeasured) {
    return { preferMeasured: true, measured, bodyMeasurable }
  }
  if (!args.mayLatchDesync || !bodyMeasurable) {
    return { preferMeasured: false, measured, bodyMeasurable }
  }
  const bodyRect = body.getBoundingClientRect()
  const overlayRect = args.overlay.getBoundingClientRect()
  // Why: skip until the overlay itself has a real box — pre-paint zeros are not desync.
  if (!isMeasurableOverlayRect(overlayRect)) {
    return { preferMeasured: false, measured, bodyMeasurable }
  }
  if (isOverlaySlotGeometryMismatched(overlayRect, bodyRect)) {
    return { preferMeasured: true, measured, bodyMeasurable }
  }
  return { preferMeasured: false, measured, bodyMeasurable }
}
