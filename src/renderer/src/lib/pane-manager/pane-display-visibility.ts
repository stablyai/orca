import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

export function isManagedPaneDisplayNone(pane: ManagedPane): boolean {
  const element = (pane as ManagedPaneInternal).xtermContainer ?? pane.container
  return isElementDisplayNone(element)
}

export function isElementDisplayNone(element: HTMLElement | null | undefined): boolean {
  const view = element?.ownerDocument?.defaultView
  if (!element || !view) {
    return false
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (view.getComputedStyle(current).display === 'none') {
      return true
    }
  }
  return false
}
