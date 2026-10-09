/** Marks each tab's direct child of the strip with its tab id; menu triggers rendered beside tabs are out of flow and unmarked. */
const SLOT_SELECTOR = '[data-tab-strip-slot]'
/** Marks the slot of the tab that renders active; it is sticky, so it docks to the edge it would scroll past. */
const DOCK_SELECTOR = '[data-active-tab-dock]'

export type ActiveTabDockSide = 'start' | 'end'

function getSlots(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>(`:scope > ${SLOT_SELECTOR}`))
}

function getSlotId(slot: HTMLElement): string {
  return slot.dataset.tabStripSlot ?? ''
}

function getActiveTabDock(strip: HTMLElement): HTMLElement | null {
  return strip.querySelector<HTMLElement>(`:scope > ${DOCK_SELECTOR}`)
}

export function findTabStripSlot(strip: HTMLElement, tabId: string): HTMLElement | undefined {
  return getSlots(strip).find((slot) => getSlotId(slot) === tabId)
}

export function readTabStripSlotIds(strip: HTMLElement): ReadonlySet<string> {
  return new Set(getSlots(strip).map(getSlotId))
}

/** Viewport span of `slot`'s place in the tab order; only the dock is drawn anywhere else. */
function getSlotNaturalSpan(strip: HTMLElement, slot: HTMLElement): [number, number] {
  const rect = slot.getBoundingClientRect()
  if (!slot.matches(DOCK_SELECTOR)) {
    return [rect.left, rect.right]
  }
  let prev = slot.previousElementSibling
  while (prev && !prev.matches(SLOT_SELECTOR)) {
    prev = prev.previousElementSibling
  }
  const left = prev
    ? prev.getBoundingClientRect().right
    : strip.getBoundingClientRect().left + strip.clientLeft - strip.scrollLeft
  return [left, left + rect.width]
}

/** Which edge `slot`'s place in the tab order is past; null when that place is on screen. */
function getSlotOffscreenSide(strip: HTMLElement, slot: HTMLElement): ActiveTabDockSide | null {
  const viewLeft = strip.getBoundingClientRect().left + strip.clientLeft
  const [left, right] = getSlotNaturalSpan(strip, slot)
  if (left < viewLeft - 1) {
    return 'start'
  }
  if (right > viewLeft + strip.clientWidth + 1) {
    return 'end'
  }
  return null
}

export function getActiveTabDockSide(strip: HTMLElement): ActiveTabDockSide | null {
  const dock = getActiveTabDock(strip)
  return dock ? getSlotOffscreenSide(strip, dock) : null
}

/** True when `el` belongs to the active tab and is drawn docked at an edge instead of its real spot. */
export function isDockedTabStripElement(strip: HTMLElement, el: Element): boolean {
  const dock = getActiveTabDock(strip)
  return dock !== null && dock.contains(el) && getSlotOffscreenSide(strip, dock) !== null
}

/** The first slot missing from `knownIds` whose place in the tab order is off screen. */
export function findOffscreenOpenedTabStripSlot(
  strip: HTMLElement,
  knownIds: ReadonlySet<string>
): HTMLElement | undefined {
  return getSlots(strip).find(
    (slot) => !knownIds.has(getSlotId(slot)) && getSlotOffscreenSide(strip, slot) !== null
  )
}

/**
 * Scroll the least distance that shows `slot` at its real spot. Why not scrollIntoView: a docked
 * tab already looks on screen, so it would not scroll. The docked active tab is shown alongside
 * when both fit; otherwise room is left for it to dock beside `slot` instead of covering it.
 */
export function revealTabStripSlot(strip: HTMLElement, slot: HTMLElement): void {
  let [left, right] = getSlotNaturalSpan(strip, slot)
  const dock = getActiveTabDock(strip)
  if (dock && dock !== slot) {
    const [dockLeft, dockRight] = getSlotNaturalSpan(strip, dock)
    if (Math.max(right, dockRight) - Math.min(left, dockLeft) <= strip.clientWidth) {
      left = Math.min(left, dockLeft)
      right = Math.max(right, dockRight)
    } else if (dockRight <= left) {
      left -= dockRight - dockLeft
    } else if (dockLeft >= right) {
      right += dockRight - dockLeft
    }
  }
  const viewLeft = strip.getBoundingClientRect().left + strip.clientLeft
  if (left < viewLeft) {
    strip.scrollLeft -= viewLeft - left
  } else if (right > viewLeft + strip.clientWidth) {
    strip.scrollLeft += Math.min(left - viewLeft, right - viewLeft - strip.clientWidth)
  }
}
