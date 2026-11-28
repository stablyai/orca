import type { Terminal } from '@xterm/xterm'

const CORE_MOUSE_BUTTON_WHEEL = 4
const CORE_MOUSE_ACTION_UP = 0
const CORE_MOUSE_ACTION_DOWN = 1

export type CachedScreenRect = {
  left: number
  top: number
  width: number
  height: number
}

type TerminalWheelDimensions = {
  css?: {
    cell?: { width?: number; height?: number }
    canvas?: { width?: number; height?: number }
  }
}

type CoreMouseEventPayload = {
  col: number
  row: number
  x: number
  y: number
  button: number
  action: number
  ctrl: boolean
  alt: boolean
  shift: boolean
}

type TerminalMouseCore = {
  _register?: (disposable: { dispose(): void }) => void
  register?: (disposable: { dispose(): void }) => void
  _renderService?: { dimensions?: TerminalWheelDimensions }
  screenElement?: HTMLElement | null
  buffer?: { cols?: number; rows?: number }
  mouseStateService?: {
    areMouseEventsActive?: boolean
    isDefaultEncoding?: boolean
    restrictMouseEvent?: (event: CoreMouseEventPayload) => boolean
    encodeMouseEvent?: (event: CoreMouseEventPayload) => string
  }
  coreService?: {
    triggerDataEvent?: (data: string, wasUserInput?: boolean) => void
    triggerBinaryEvent?: (data: string) => void
  }
}

export type TerminalWheelTarget = Pick<
  Terminal,
  'attachCustomWheelEventHandler' | 'element' | 'rows'
> & {
  cols?: number
  modes: Pick<Terminal['modes'], 'mouseTrackingMode'>
  dimensions?: TerminalWheelDimensions
  onResize?: (listener: () => void) => { dispose(): void }
  _core?: TerminalMouseCore
}

export function resolveScreenElement(terminal: TerminalWheelTarget): HTMLElement | null {
  const coreScreen = terminal._core?.screenElement
  if (coreScreen) {
    return coreScreen
  }
  const queried = terminal.element?.querySelector('.xterm-screen') ?? null
  return queried instanceof HTMLElement ? queried : (terminal.element ?? null)
}

export function readCachedWheelDimensions(
  terminal: TerminalWheelTarget
): TerminalWheelDimensions | undefined {
  return terminal.dimensions ?? terminal._core?._renderService?.dimensions
}

export function measureScreenRect(terminal: TerminalWheelTarget): CachedScreenRect | null {
  const screenElement = resolveScreenElement(terminal)
  if (!screenElement) {
    return null
  }
  const rect = screenElement.getBoundingClientRect()
  if (!(rect.width > 0 && rect.height > 0)) {
    return null
  }
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export function resolveTerminalWheelCellHeight(
  terminal: TerminalWheelTarget,
  cachedScreenRect: CachedScreenRect | null,
  onMeasuredRect?: (rect: CachedScreenRect) => void
): number | undefined {
  const cachedCellHeight = readCachedWheelDimensions(terminal)?.css?.cell?.height
  if (
    typeof cachedCellHeight === 'number' &&
    Number.isFinite(cachedCellHeight) &&
    cachedCellHeight > 0
  ) {
    return cachedCellHeight
  }
  const rect = cachedScreenRect ?? measureScreenRect(terminal)
  if (rect && !cachedScreenRect) {
    onMeasuredRect?.(rect)
  }
  if (!rect || rect.height <= 0 || terminal.rows <= 0) {
    return undefined
  }
  return rect.height / terminal.rows
}

export function emitCoalescedCoreWheelReports(
  terminal: TerminalWheelTarget,
  cachedScreenRect: CachedScreenRect | null,
  event: WheelEvent,
  direction: -1 | 1,
  reportsToDispatch: number
): boolean {
  const core = terminal._core
  const mouseState = core?.mouseStateService
  const coreService = core?.coreService
  const dims = readCachedWheelDimensions(terminal)?.css
  const cellWidth = dims?.cell?.width
  const cellHeight = dims?.cell?.height
  const canvasWidth = dims?.canvas?.width
  const canvasHeight = dims?.canvas?.height
  if (
    !mouseState ||
    !coreService ||
    typeof mouseState.restrictMouseEvent !== 'function' ||
    typeof mouseState.encodeMouseEvent !== 'function' ||
    typeof cellWidth !== 'number' ||
    !(cellWidth > 0) ||
    typeof cellHeight !== 'number' ||
    !(cellHeight > 0) ||
    typeof canvasWidth !== 'number' ||
    !(canvasWidth > 0) ||
    typeof canvasHeight !== 'number' ||
    !(canvasHeight > 0)
  ) {
    return false
  }
  const cols = core.buffer?.cols ?? terminal.cols ?? 0
  const rows = core.buffer?.rows ?? terminal.rows
  if (cols <= 0 || rows <= 0) {
    return false
  }
  const rect = cachedScreenRect ?? measureScreenRect(terminal)
  const relXRaw = rect ? event.clientX - rect.left : 0
  const relYRaw = rect ? event.clientY - rect.top : 0
  if (!Number.isFinite(relXRaw) || !Number.isFinite(relYRaw)) {
    return false
  }
  const clampedX = Math.min(Math.max(relXRaw, 0), canvasWidth - 1)
  const clampedY = Math.min(Math.max(relYRaw, 0), canvasHeight - 1)
  const col = Math.min(cols - 1, Math.max(0, Math.floor(clampedX / cellWidth)))
  const row = Math.min(rows - 1, Math.max(0, Math.floor(clampedY / cellHeight)))
  // Report 1-based col/row matching xterm MouseService._triggerMouseEvent.
  const mouseEvent: CoreMouseEventPayload = {
    col: col + 1,
    row: row + 1,
    x: Math.floor(clampedX),
    y: Math.floor(clampedY),
    button: CORE_MOUSE_BUTTON_WHEEL,
    action: direction < 0 ? CORE_MOUSE_ACTION_UP : CORE_MOUSE_ACTION_DOWN,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  }
  if (!mouseState.restrictMouseEvent(mouseEvent)) {
    return false
  }
  const report = mouseState.encodeMouseEvent(mouseEvent)
  if (!report) {
    return true
  }
  const payload = reportsToDispatch === 1 ? report : report.repeat(reportsToDispatch)
  if (mouseState.isDefaultEncoding) {
    if (typeof coreService.triggerBinaryEvent !== 'function') {
      return false
    }
    coreService.triggerBinaryEvent(payload)
  } else {
    if (typeof coreService.triggerDataEvent !== 'function') {
      return false
    }
    coreService.triggerDataEvent(payload, true)
  }
  return true
}
