import type { IDisposable, Terminal } from '@xterm/xterm'
import type { ManagedPane } from './pane-manager-types'
import { getFitOverrideForPty } from './mobile-fit-overrides'
import { readTerminalStableCellSize } from './terminal-stable-cell-fit-addon'
import { terminalBoxSizeForGrid, type TerminalFitMetrics } from './terminal-grid-size-for-box'

type ScrollViewportState = {
  element: HTMLElement
  viewport: HTMLElement
  width: string
  height: string
  overflow: string
  overscrollBehavior: string
  hadScrollbarClass: boolean
  sharedGridAttribute: string | undefined
  padding: TerminalFitMetrics['padding']
  rendered?: IDisposable
  revealCursor: boolean
}

const viewports = new WeakMap<Terminal, ScrollViewportState>()

function restoreViewport(terminal: Terminal): void {
  const state = viewports.get(terminal)
  if (!state) {
    return
  }
  viewports.delete(terminal)
  state.rendered?.dispose()
  state.element.style.width = state.width
  state.element.style.height = state.height
  state.viewport.style.overflow = state.overflow
  state.viewport.style.overscrollBehavior = state.overscrollBehavior
  if (state.sharedGridAttribute === undefined) {
    delete state.viewport.dataset.localSharedGrid
  } else {
    state.viewport.dataset.localSharedGrid = state.sharedGridAttribute
  }
  if (!state.hadScrollbarClass) {
    state.viewport.classList.remove('scrollbar-editor')
  }
  state.viewport.scrollLeft = 0
  state.viewport.scrollTop = 0
}

/** Keep the shared VT grid at native cell size; only this window's enclosing box scrolls. */
export function syncLocalSharedTerminalViewport(pane: ManagedPane): void {
  const ptyId = pane.container.dataset?.ptyId
  const override = ptyId ? getFitOverrideForPty(ptyId) : null
  const terminal = pane.terminal
  if (!override?.localSharedGrid) {
    restoreViewport(terminal)
    return
  }
  const element = terminal.element
  const viewport = element?.parentElement
  const cell = readTerminalStableCellSize(terminal)
  const view = element?.ownerDocument.defaultView
  if (!element || !viewport || !cell || !view) {
    return
  }
  let state = viewports.get(terminal)
  if (!state) {
    const style = view.getComputedStyle(element)
    state = {
      element,
      viewport,
      width: element.style.width,
      height: element.style.height,
      overflow: viewport.style.overflow,
      overscrollBehavior: viewport.style.overscrollBehavior,
      hadScrollbarClass: viewport.classList.contains('scrollbar-editor'),
      sharedGridAttribute: viewport.dataset.localSharedGrid,
      padding: {
        top: Number.parseFloat(style.paddingTop) || 0,
        right: Number.parseFloat(style.paddingRight) || 0,
        bottom: Number.parseFloat(style.paddingBottom) || 0,
        left: Number.parseFloat(style.paddingLeft) || 0
      },
      revealCursor: false
    }
    viewports.set(terminal, state)
    viewport.style.overflow = 'auto'
    viewport.style.overscrollBehavior = 'contain'
    viewport.classList.add('scrollbar-editor')
    viewport.dataset.localSharedGrid = 'true'
    state.rendered = terminal.onRender?.(() => syncLocalSharedTerminalViewport(pane))
  }
  const size = terminalBoxSizeForGrid(override, {
    cell,
    padding: state.padding,
    scrollback: terminal.options.scrollback,
    scrollbar: terminal.options.scrollbar
  })
  const width = `${size.width}px`
  const height = `${size.height}px`
  if (element.style.width !== width) {
    element.style.width = width
  }
  if (element.style.height !== height) {
    element.style.height = height
  }
  if (state.revealCursor) {
    state.revealCursor = false
    const buffer = terminal.buffer.active
    const left = buffer.cursorX * cell.width
    const top = buffer.cursorY * cell.height
    if (left < viewport.scrollLeft) {
      viewport.scrollLeft = left
    } else if (left + cell.width > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = left + cell.width - viewport.clientWidth
    }
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top
    } else if (top + cell.height > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + cell.height - viewport.clientHeight
    }
  }
}

export function revealLocalSharedTerminalCursor(pane: ManagedPane): void {
  syncLocalSharedTerminalViewport(pane)
  const state = viewports.get(pane.terminal)
  if (state) {
    state.revealCursor = true
    syncLocalSharedTerminalViewport(pane)
    // Silent input needs immediate visibility; the next render may move the response cursor.
    state.revealCursor = true
  }
}
