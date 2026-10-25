import { useMemo, useState, useSyncExternalStore } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import {
  withHeldProjectRecency,
  type SidebarFeedIndex
} from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import { mergeHeldOrder } from './held-order'

const LIST_SELECTOR = '[data-worktree-sidebar-container]'

let pointerInside = false
let pressedInside = false
let dragging = false
const listeners = new Set<() => void>()

function inList(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(LIST_SELECTOR) !== null
}

function update(next: { inside?: boolean; pressed?: boolean; drag?: boolean }): void {
  const before = isEngaged()
  pointerInside = next.inside ?? pointerInside
  pressedInside = next.pressed ?? pressedInside
  dragging = next.drag ?? dragging
  if (before !== isEngaged()) {
    listeners.forEach((listener) => listener())
  }
}

function isEngaged(): boolean {
  return pointerInside || pressedInside || dragging
}

const DOCUMENT_HANDLERS: [string, (event: Event) => void][] = [
  ['pointerover', (event) => update({ inside: inList(event.target) })],
  [
    'pointerout',
    (event) => {
      if (event instanceof PointerEvent && event.relatedTarget === null) {
        update({ inside: false })
      }
    }
  ],
  ['pointerdown', (event) => update({ pressed: inList(event.target) })],
  ['pointerup', () => update({ pressed: false })],
  ['pointercancel', () => update({ pressed: false })],
  ['dragstart', (event) => update({ drag: inList(event.target) })],
  // Pointer events pause during a drag, so its end also ends the hover hold.
  ['dragend', () => update({ drag: false, inside: false })],
  ['drop', () => update({ drag: false, inside: false })]
]

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    for (const [type, handler] of DOCUMENT_HANDLERS) {
      document.addEventListener(type, handler, true)
    }
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      for (const [type, handler] of DOCUMENT_HANDLERS) {
        document.removeEventListener(type, handler, true)
      }
      pointerInside = pressedInside = dragging = false
    }
  }
}

const noSubscription = (): (() => void) => () => {}
const notEngaged = (): boolean => false

function useListEngaged(): boolean {
  // Only the main-input path needs event-driven hover holds; the legacy list settles independently.
  return useSyncExternalStore(
    ORCA_SIDEBAR_INPUTS_IS_MAIN ? subscribe : noSubscription,
    ORCA_SIDEBAR_INPUTS_IS_MAIN ? isEngaged : notEngaged,
    notEngaged
  )
}

/** Hold Recent/Smart order during hover or drag so clicks cannot target moving rows; release on leave/end. */
export function useOrderHeldWhileEngaged(ids: string[], sortBy: SortBy): string[] {
  const engaged = useListEngaged()
  const [shown, setShown] = useState({ ids, sortBy })
  // Only Recent and Smart move on their own; a mode switch applies at once, like adds and removals.
  const holds = engaged && (sortBy === 'recent' || sortBy === 'smart')
  const next =
    holds && shown.sortBy === sortBy
      ? { ids: mergeHeldOrder(shown.ids, ids), sortBy }
      : { ids, sortBy }
  const changed = next.ids !== shown.ids || next.sortBy !== shown.sortBy
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN && changed) {
    setShown(next)
  }
  return ORCA_SIDEBAR_INPUTS_IS_MAIN ? next.ids : ids
}

/** As above for project sections in Recent order: they keep the stamps they had at engagement. */
export function useProjectRecencyHeldWhileEngaged(
  index: SidebarFeedIndex,
  projectOrderBy: ProjectOrderBy
): SidebarFeedIndex {
  const holds = useListEngaged() && projectOrderBy === 'recent'
  const [heldFrom, setHeldFrom] = useState<SidebarFeedIndex | null>(null)
  const nextHeldFrom = holds ? (heldFrom ?? index) : null
  if (nextHeldFrom !== heldFrom) {
    setHeldFrom(nextHeldFrom)
  }
  return useMemo(
    () => (nextHeldFrom ? withHeldProjectRecency(index, nextHeldFrom) : index),
    [index, nextHeldFrom]
  )
}
