import type { WorkspaceSplitDropZone } from './split-pane-drop-target'

// Why imperative: the sidebar pointer drag updates per animation frame; going
// through the store would re-render the sidebar tree on every pointer move.
// Mirrors the kanban board's sidebar drop-target visual pattern.
let highlightElement: HTMLElement | null = null

export function registerWorkspaceSplitDropHighlight(element: HTMLElement | null): void {
  highlightElement = element
  if (element) {
    element.style.display = 'none'
  }
}

export function updateWorkspaceSplitDropHighlight(zone: WorkspaceSplitDropZone | null): void {
  const element = highlightElement
  if (!element) {
    return
  }
  if (!zone) {
    element.style.display = 'none'
    return
  }
  element.style.display = 'block'
  element.style.left = `${zone.highlightRect.left}px`
  element.style.top = `${zone.highlightRect.top}px`
  element.style.width = `${zone.highlightRect.width}px`
  element.style.height = `${zone.highlightRect.height}px`
}
