// Partial DOM overlays (menus, tooltips, popovers) show through holes cut in a pane's native
// view; overlays that need the whole pane still hide it, so xterm draws underneath instead.
export type NativeTerminalOverlay = {
  rect: DOMRect
  // The rect plus the overlay's shadow, which also has to show through.
  padded: DOMRect
  alwaysCovers: boolean
  // Menus and switchers take the keys; tooltips are pointer-events-none labels that never do.
  takesKeyboard: boolean
}

type Edges = { top: number; right: number; bottom: number; left: number }

const POPPER_SELECTOR = '[data-radix-popper-content-wrapper]'
// Why: modal dialogs dim the whole window, and in-pane search highlights are drawn by xterm.
const ALWAYS_COVERS_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [data-terminal-search-root], .pane-drop-overlay'
const TOOLTIP_SELECTOR = '[data-slot="tooltip-content"], [role="tooltip"]'
// Antialiased edges and subpixel layout around the overlay box.
const HOLE_MARGIN_PX = 2
// Beyond this share of the pane, hiding beats painting a native frame that is mostly holes.
const MAX_COVERED_SHARE = 0.5
const MAX_HOLES = 8

const NO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 }

// How far an outer box-shadow paints beyond the box on each side.
export function boxShadowExtent(boxShadow: string): Edges {
  if (boxShadow === '' || boxShadow === 'none') {
    return NO_EDGES
  }
  const extent = { ...NO_EDGES }
  // Commas inside rgb()/rgba() would otherwise split one shadow into several.
  for (const shadow of boxShadow.split(/,(?![^(]*\))/)) {
    if (/\binset\b/.test(shadow)) {
      continue
    }
    const lengths = Array.from(
      shadow.replace(/\([^)]*\)/g, '').matchAll(/(-?[\d.]+)px/g),
      (match) => Number.parseFloat(match[1])
    )
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths
    const reach = Math.max(0, blur + spread)
    extent.top = Math.max(extent.top, reach - y)
    extent.bottom = Math.max(extent.bottom, reach + y)
    extent.left = Math.max(extent.left, reach - x)
    extent.right = Math.max(extent.right, reach + x)
  }
  return extent
}

function shadowOf(element: Element): Edges {
  const own = boxShadowExtent(getComputedStyle(element).boxShadow)
  // Radix poppers put the shadow on the content inside the positioning wrapper.
  const child = element.firstElementChild
  if (!child) {
    return own
  }
  const inner = boxShadowExtent(getComputedStyle(child).boxShadow)
  return {
    top: Math.max(own.top, inner.top),
    right: Math.max(own.right, inner.right),
    bottom: Math.max(own.bottom, inner.bottom),
    left: Math.max(own.left, inner.left)
  }
}

export function describeOverlay(element: Element, rect: DOMRect): NativeTerminalOverlay {
  const shadow = shadowOf(element)
  const padded = new DOMRect(
    rect.left - shadow.left - HOLE_MARGIN_PX,
    rect.top - shadow.top - HOLE_MARGIN_PX,
    rect.width + shadow.left + shadow.right + 2 * HOLE_MARGIN_PX,
    rect.height + shadow.top + shadow.bottom + 2 * HOLE_MARGIN_PX
  )
  const alwaysCovers =
    element.matches(ALWAYS_COVERS_SELECTOR) && element.closest(POPPER_SELECTOR) === null
  const takesKeyboard =
    !element.matches(TOOLTIP_SELECTOR) && element.querySelector(TOOLTIP_SELECTOR) === null
  return { rect, padded, alwaysCovers, takesKeyboard }
}

function intersection(a: DOMRect, b: DOMRect): DOMRect | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null
}

// Why bounding boxes: the mask is drawn even-odd, where two overlapping holes would cancel.
export function mergeOverlappingRects(rects: readonly DOMRect[]): DOMRect[] {
  const merged = [...rects]
  // A grown box can reach one already passed over, so merge until nothing overlaps.
  for (let pair = overlappingPair(merged); pair; pair = overlappingPair(merged)) {
    const [i, j] = pair
    const left = Math.min(merged[i].left, merged[j].left)
    const top = Math.min(merged[i].top, merged[j].top)
    const right = Math.max(merged[i].right, merged[j].right)
    const bottom = Math.max(merged[i].bottom, merged[j].bottom)
    merged[i] = new DOMRect(left, top, right - left, bottom - top)
    merged.splice(j, 1)
  }
  return merged
}

function overlappingPair(rects: readonly DOMRect[]): [number, number] | null {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (intersection(rects[i], rects[j])) {
        return [i, j]
      }
    }
  }
  return null
}

// Why: a tooltip over the pane (the 12 s startup hint, say) must not take the keys from its view.
export function overlaysTakeKeyboard(
  pane: DOMRect,
  overlays: readonly NativeTerminalOverlay[]
): boolean {
  return overlays.some(
    (overlay) => overlay.takesKeyboard && intersection(pane, overlay.rect) !== null
  )
}

// Holes (CSS px, clipped to the pane) for the overlays over this pane, or null when the
// native view has to hide instead.
export function overlayHoles(
  pane: DOMRect,
  overlays: readonly NativeTerminalOverlay[]
): DOMRect[] | null {
  const hits = overlays.filter((overlay) => intersection(pane, overlay.rect) !== null)
  if (hits.some((overlay) => overlay.alwaysCovers)) {
    return null
  }
  const clipped = hits.flatMap((overlay) => intersection(pane, overlay.padded) ?? [])
  const holes = mergeOverlappingRects(clipped)
  const covered = holes.reduce((sum, hole) => sum + hole.width * hole.height, 0)
  if (holes.length > MAX_HOLES || covered > MAX_COVERED_SHARE * pane.width * pane.height) {
    return null
  }
  return holes
}
