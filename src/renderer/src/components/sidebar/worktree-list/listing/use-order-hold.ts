import { useMemo, useState, useSyncExternalStore } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import {
  withHeldProjectRecency,
  type SidebarFeedIndex
} from '../../../../../../shared/sidebar-list/feed/sidebar-feed-index'
import type { WorkspaceSortBy as SortBy } from '../../../../../../shared/workspace-view/workspace-row-sort'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import { mergeHeldOrder } from './held-order'
import { reuseArrayIfEqual } from '../../workspace-card/activity/worktree-agent-row-selectors'

/** The lists that hold their order; each holds only while engaged with itself. */
export type OrderHoldList = 'projects' | 'bots'

const LIST_SELECTORS: [OrderHoldList, string][] = [
  ['projects', '[data-worktree-sidebar-container]'],
  ['bots', '[data-bot-sidebar-list]']
]

let pointerList: OrderHoldList | null = null
let pressedList: OrderHoldList | null = null
let dragList: OrderHoldList | null = null
const listeners = new Set<() => void>()

function listOf(target: EventTarget | null): OrderHoldList | null {
  if (!(target instanceof Element)) {
    return null
  }
  return LIST_SELECTORS.find(([, selector]) => target.closest(selector) !== null)?.[0] ?? null
}

type Engagement = {
  pointer: OrderHoldList | null
  pressed: OrderHoldList | null
  drag: OrderHoldList | null
}

function update(next: Partial<Engagement>): void {
  const before = [pointerList, pressedList, dragList].join()
  pointerList = next.pointer === undefined ? pointerList : next.pointer
  pressedList = next.pressed === undefined ? pressedList : next.pressed
  dragList = next.drag === undefined ? dragList : next.drag
  if (before !== [pointerList, pressedList, dragList].join()) {
    listeners.forEach((listener) => listener())
  }
}

function isEngaged(list: OrderHoldList): boolean {
  return pointerList === list || pressedList === list || dragList === list
}

const DOCUMENT_HANDLERS: [string, (event: Event) => void][] = [
  ['pointerover', (event) => update({ pointer: listOf(event.target) })],
  [
    'pointerout',
    (event) => {
      if (event instanceof PointerEvent && event.relatedTarget === null) {
        update({ pointer: null })
      }
    }
  ],
  ['pointerdown', (event) => update({ pressed: listOf(event.target) })],
  ['pointerup', () => update({ pressed: null })],
  ['pointercancel', () => update({ pressed: null })],
  ['dragstart', (event) => update({ drag: listOf(event.target) })],
  // Pointer events pause during a drag, so its end also ends the hover hold.
  ['dragend', () => update({ drag: null, pointer: null })],
  ['drop', () => update({ drag: null, pointer: null })]
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
      pointerList = pressedList = dragList = null
    }
  }
}

const noSubscription = (): (() => void) => () => {}
const notEngaged = (): boolean => false
const ENGAGED_BY_LIST: Record<OrderHoldList, () => boolean> = {
  projects: () => isEngaged('projects'),
  bots: () => isEngaged('bots')
}

// The legacy projects list settles on its own; the bots list has only this hold, in every build.
function holdsInThisBuild(list: OrderHoldList): boolean {
  return list === 'bots' || ORCA_SIDEBAR_INPUTS_IS_MAIN
}

function useListEngaged(list: OrderHoldList): boolean {
  const enabled = holdsInThisBuild(list)
  return useSyncExternalStore(
    enabled ? subscribe : noSubscription,
    enabled ? ENGAGED_BY_LIST[list] : notEngaged,
    notEngaged
  )
}

/** Hold Recent/Smart order during hover or drag so clicks cannot target moving rows; release on leave/end. */
export function useOrderHeldWhileEngaged(
  ids: string[],
  sortBy: SortBy,
  list: OrderHoldList = 'projects'
): string[] {
  const engaged = useListEngaged(list)
  const [shown, setShown] = useState({ ids, sortBy })
  // Only Recent and Smart move on their own; a mode switch applies at once, like adds and removals.
  const holds = engaged && (sortBy === 'recent' || sortBy === 'smart')
  // Reuse an equal order: the render-time setState below would loop on a fresh array each render.
  const next =
    holds && shown.sortBy === sortBy
      ? { ids: mergeHeldOrder(shown.ids, ids), sortBy }
      : { ids: reuseArrayIfEqual(shown.ids, ids), sortBy }
  const changed = next.ids !== shown.ids || next.sortBy !== shown.sortBy
  const enabled = holdsInThisBuild(list)
  if (enabled && changed) {
    setShown(next)
  }
  return enabled ? next.ids : ids
}

/** As above for project sections in Recent order: they keep the stamps they had at engagement. */
export function useProjectRecencyHeldWhileEngaged(
  index: SidebarFeedIndex,
  projectOrderBy: ProjectOrderBy
): SidebarFeedIndex {
  const holds = useListEngaged('projects') && projectOrderBy === 'recent'
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
