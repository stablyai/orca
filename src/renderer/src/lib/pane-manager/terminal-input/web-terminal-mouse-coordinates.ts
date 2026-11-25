import type { Terminal } from '@xterm/xterm'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'

type Point = Pick<MouseEvent, 'clientX' | 'clientY'>

type MouseCoordinateServices = {
  _mouseCoordsService?: {
    getCoords: (
      event: Point,
      element: HTMLElement,
      cols: number,
      rows: number,
      selection?: boolean
    ) => [number, number] | undefined
    getMouseReportCoords: (
      event: Point,
      element: HTMLElement
    ) => { col: number; row: number; x: number; y: number } | undefined
  }
  _selectionService?: { _getMouseEventScrollAmount: (event: Point) => number }
}

function logicalPointer(event: Point, element: HTMLElement): Point {
  const zoom =
    element.currentCSSZoom || Number(element.ownerDocument.documentElement.style.zoom) || 1
  if (zoom === 1) {
    return event
  }
  const { left, top } = element.getBoundingClientRect()
  return {
    clientX: left + (event.clientX - left) / zoom,
    clientY: top + (event.clientY - top) / zoom
  }
}

/** xterm subtracts the screen rect from viewport coordinates, then measures in unscaled cell pixels. */
export function installWebTerminalMouseCoordinates(terminal: Terminal): void {
  if (!isPairedWebClientWindow()) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm provides no public coordinate hook. Check the pinned services before wrapping them.
  const core = (terminal as unknown as { _core?: MouseCoordinateServices })._core
  const mouse = core?._mouseCoordsService
  const selection = core?._selectionService
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (typeof mouse?.getCoords === 'function' && typeof mouse.getMouseReportCoords === 'function') {
    const getCoords = mouse.getCoords.bind(mouse)
    const getReport = mouse.getMouseReportCoords.bind(mouse)
    mouse.getCoords = (event, element, ...args) =>
      getCoords(logicalPointer(event, element), element, ...args)
    mouse.getMouseReportCoords = (event, element) =>
      getReport(logicalPointer(event, element), element)
  }
  if (screen && typeof selection?._getMouseEventScrollAmount === 'function') {
    const getScroll = selection._getMouseEventScrollAmount.bind(selection)
    selection._getMouseEventScrollAmount = (event) => getScroll(logicalPointer(event, screen))
  }
}
