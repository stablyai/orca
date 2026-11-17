import type React from 'react'
import { useLayoutEffect } from 'react'

// Focus and inertness for the Orca Cloud covers (archived, waking, asleep) over a workspace's panes.

/** After a menu closes and restores focus to its trigger (Radix defers that a tick). */
export const MENU_FOCUS_RETURN_MS = 60

export function isEditable(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
  )
}

/** Did the pane this layer is about to cover hold focus (or nothing did)? Then the layer takes it. */
export function coveredPaneHadFocus(cover: HTMLElement | null): boolean {
  const active = document.activeElement
  const pane = cover?.parentElement
  return !active || active === document.body || Boolean(pane && pane.contains(active))
}

// Shared across covers: an element stays inert while any cover still holds it, and an element
// that was inert before any cover arrived (some other owner) is never released by us.
const inertHolds = new Map<HTMLElement, number>()

function holdInert(element: HTMLElement): void {
  const holds = inertHolds.get(element)
  if (holds === undefined) {
    if (element.inert) {
      return
    }
    element.inert = true
  }
  inertHolds.set(element, (holds ?? 0) + 1)
}

function releaseInert(element: HTMLElement): void {
  const holds = inertHolds.get(element)
  if (holds === undefined) {
    return
  }
  if (holds <= 1) {
    inertHolds.delete(element)
    element.inert = false
  } else {
    inertHolds.set(element, holds - 1)
  }
}

/** Marks every sibling of the cover (the panes it hides) inert while it is shown. */
export function useInertSiblings(
  cover: React.RefObject<HTMLElement | null>,
  active: boolean
): void {
  useLayoutEffect(() => {
    const element = cover.current
    const parent = element?.parentElement
    if (!active || !element || !parent) {
      return
    }
    const held: HTMLElement[] = []
    for (const child of Array.from(parent.children)) {
      if (
        child !== element &&
        child instanceof HTMLElement &&
        !child.hasAttribute('data-cloud-surface')
      ) {
        holdInert(child)
        held.push(child)
      }
    }
    return () => held.forEach(releaseInert)
  }, [cover, active])
}
