import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

// Why: measure the element FitAddon fits (the xterm host), not the outer .pane —
// a title/banner can shrink the inner fittable area while the outer stays put.
// Round to whole pixels so sub-pixel jitter never reads as a resize.
export function readFitClientSize(pane: ManagedPane): { width: number; height: number } | null {
  const element = (pane as ManagedPaneInternal).xtermContainer ?? pane.container
  const measure = element?.getBoundingClientRect
  if (typeof measure !== 'function') {
    return null
  }
  const rect = measure.call(element)
  return { width: Math.round(rect.width), height: Math.round(rect.height) }
}

export function recordPaneFitClientSize(pane: ManagedPane): void {
  const size = readFitClientSize(pane)
  if (size && size.width > 0 && size.height > 0) {
    ;(pane as ManagedPaneInternal).lastFitClientSize = size
  }
}
