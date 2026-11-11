export type PanePtyResizeHoldFlushDetail = {
  cols: number
  rows: number
}

export const PANE_PTY_RESIZE_HOLD_FLUSH_EVENT = 'orca-pane-pty-resize-hold-flush'

type ResizeHoldState = {
  depth: number
  pending: PanePtyResizeHoldFlushDetail | null
}

const resizeHolds = new WeakMap<HTMLElement, ResizeHoldState>()

function getOrCreateHoldState(paneElement: HTMLElement): ResizeHoldState {
  const existing = resizeHolds.get(paneElement)
  if (existing) {
    return existing
  }
  const next: ResizeHoldState = { depth: 0, pending: null }
  resizeHolds.set(paneElement, next)
  return next
}

function beginPanePtyResizeHold(paneElement: HTMLElement): void {
  const state = getOrCreateHoldState(paneElement)
  state.depth += 1
}

export function queuePanePtyResizeIfHeld(
  paneElement: HTMLElement,
  cols: number,
  rows: number
): boolean {
  const state = resizeHolds.get(paneElement)
  if (!state) {
    return false
  }
  state.pending = { cols, rows }
  return true
}

function flushPanePtyResizeHold(paneElement: HTMLElement): void {
  const state = resizeHolds.get(paneElement)
  if (!state) {
    return
  }
  state.depth -= 1
  if (state.depth > 0) {
    return
  }
  resizeHolds.delete(paneElement)
  if (!state.pending) {
    return
  }
  paneElement.dispatchEvent(
    new CustomEvent<PanePtyResizeHoldFlushDetail>(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT, {
      detail: state.pending
    })
  )
}

function cancelPanePtyResizeHold(paneElement: HTMLElement): void {
  const state = resizeHolds.get(paneElement)
  if (!state) {
    return
  }
  state.depth -= 1
  state.pending = null
  if (state.depth <= 0) {
    resizeHolds.delete(paneElement)
  }
}

function collectPaneElements(root: HTMLElement | null, panes: Set<HTMLElement>): void {
  if (!root) {
    return
  }
  if (root.classList.contains('pane')) {
    panes.add(root)
    return
  }
  for (const pane of root.querySelectorAll<HTMLElement>('.pane[data-pane-id]')) {
    panes.add(pane)
  }
}

export function holdPtyResizesForPaneSubtrees(roots: (HTMLElement | null)[]): {
  flush: () => void
  cancel: () => void
} {
  const panes = new Set<HTMLElement>()
  for (const root of roots) {
    collectPaneElements(root, panes)
  }

  for (const pane of panes) {
    beginPanePtyResizeHold(pane)
  }

  const heldPanes = Array.from(panes)
  let released = false

  const release = (flush: boolean): void => {
    if (released) {
      return
    }
    released = true
    for (const pane of heldPanes) {
      if (flush) {
        flushPanePtyResizeHold(pane)
      } else {
        cancelPanePtyResizeHold(pane)
      }
    }
  }

  return {
    flush: () => release(true),
    cancel: () => release(false)
  }
}
