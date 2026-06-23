export const DEFAULT_PANEL_WIDTH = 920
export const DEFAULT_PANEL_HEIGHT = 560
export const MIN_PANEL_WIDTH = 420
export const MIN_PANEL_HEIGHT = 280
export const MAXIMIZED_MARGIN = 12
export const MAXIMIZED_BOTTOM_GAP = 36
export const TITLEBAR_SAFE_TOP = 36
const DEFAULT_RIGHT_GAP = 24
const DEFAULT_BOTTOM_GAP = 84
const PANEL_EDGE_MARGIN = 8

export const FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY = 'orca-floating-terminal-panel-bounds-v1'

export type FloatingTerminalPanelBounds = {
  left: number
  top: number
  width: number
  height: number
}

export type FloatingTerminalPanelAnchorX = 'left' | 'right'
export type FloatingTerminalPanelAnchorY = 'top' | 'bottom'

export type FloatingTerminalAnchoredPanelBounds = {
  anchorX: FloatingTerminalPanelAnchorX
  anchorY: FloatingTerminalPanelAnchorY
  offsetX: number
  offsetY: number
  width: number
  height: number
}

export type FloatingTerminalPanelCommittedBounds =
  | FloatingTerminalPanelBounds
  | FloatingTerminalAnchoredPanelBounds

export type FloatingTerminalPanelBoundsSource = 'default' | 'user'

function getViewport(): { width: number; height: number } {
  return {
    width: typeof window === 'undefined' ? 1200 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight
  }
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAnchorX(value: unknown): value is FloatingTerminalPanelAnchorX {
  return value === 'left' || value === 'right'
}

function isAnchorY(value: unknown): value is FloatingTerminalPanelAnchorY {
  return value === 'top' || value === 'bottom'
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max)
}

function getWindowStorage(): Storage | null {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
    ? window.localStorage
    : null
}

function isAnchoredPanelBounds(
  bounds: FloatingTerminalPanelCommittedBounds
): bounds is FloatingTerminalAnchoredPanelBounds {
  return 'anchorX' in bounds
}

export function getDefaultFloatingTerminalCommittedBounds(): FloatingTerminalAnchoredPanelBounds {
  return {
    anchorX: 'right',
    anchorY: 'bottom',
    offsetX: DEFAULT_RIGHT_GAP,
    offsetY: DEFAULT_BOTTOM_GAP,
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT
  }
}

export function getDefaultFloatingTerminalBounds(): FloatingTerminalPanelBounds {
  const viewport = getViewport()
  // Why: the floating panel may touch the renderer titlebar, but must not
  // overlap it or the native window controls above it.
  const safeTop = TITLEBAR_SAFE_TOP
  const width = Math.min(DEFAULT_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewport.width - 48))
  const height = Math.min(DEFAULT_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, viewport.height - 96))
  return {
    left: Math.max(16, viewport.width - width - DEFAULT_RIGHT_GAP),
    top: Math.max(safeTop, viewport.height - height - DEFAULT_BOTTOM_GAP),
    width,
    height
  }
}

export function clampFloatingTerminalBounds(
  bounds: FloatingTerminalPanelBounds
): FloatingTerminalPanelBounds {
  const viewport = getViewport()
  const safeTop = TITLEBAR_SAFE_TOP
  const width = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(bounds.width, Math.max(MIN_PANEL_WIDTH, viewport.width - PANEL_EDGE_MARGIN * 2))
  )
  const height = Math.max(
    MIN_PANEL_HEIGHT,
    Math.min(
      bounds.height,
      Math.max(MIN_PANEL_HEIGHT, viewport.height - safeTop - PANEL_EDGE_MARGIN)
    )
  )
  const maxLeft = Math.max(PANEL_EDGE_MARGIN, viewport.width - width - PANEL_EDGE_MARGIN)
  const maxTop = Math.max(safeTop, viewport.height - height - PANEL_EDGE_MARGIN)
  return {
    left: clampValue(bounds.left, PANEL_EDGE_MARGIN, maxLeft),
    top: clampValue(bounds.top, safeTop, maxTop),
    width,
    height
  }
}

export function getMaximizedFloatingTerminalBounds(): FloatingTerminalPanelBounds {
  const viewport = getViewport()
  const top = TITLEBAR_SAFE_TOP
  return {
    left: MAXIMIZED_MARGIN,
    top,
    width: Math.max(MIN_PANEL_WIDTH, viewport.width - MAXIMIZED_MARGIN * 2),
    height: Math.max(MIN_PANEL_HEIGHT, viewport.height - top - MAXIMIZED_BOTTOM_GAP)
  }
}

export function hasUsableFloatingTerminalPanelViewport(): boolean {
  const viewport = getViewport()
  return (
    viewport.width > PANEL_EDGE_MARGIN * 2 &&
    viewport.height > TITLEBAR_SAFE_TOP + PANEL_EDGE_MARGIN
  )
}

export function canAnchorFloatingTerminalPanelBounds(): boolean {
  const viewport = getViewport()
  return (
    viewport.width >= MIN_PANEL_WIDTH + PANEL_EDGE_MARGIN * 2 &&
    viewport.height >= MIN_PANEL_HEIGHT + TITLEBAR_SAFE_TOP + PANEL_EDGE_MARGIN
  )
}

export function resolveFloatingTerminalPanelCommittedBounds(
  bounds: FloatingTerminalPanelCommittedBounds
): FloatingTerminalPanelBounds {
  if (!isAnchoredPanelBounds(bounds)) {
    return bounds
  }
  const viewport = getViewport()
  return {
    left:
      bounds.anchorX === 'left' ? bounds.offsetX : viewport.width - bounds.width - bounds.offsetX,
    top:
      bounds.anchorY === 'top' ? bounds.offsetY : viewport.height - bounds.height - bounds.offsetY,
    width: bounds.width,
    height: bounds.height
  }
}

export function anchorFloatingTerminalPanelBounds(
  bounds: FloatingTerminalPanelBounds
): FloatingTerminalAnchoredPanelBounds | null {
  if (!canAnchorFloatingTerminalPanelBounds()) {
    return null
  }
  const viewport = getViewport()
  const anchorX: FloatingTerminalPanelAnchorX =
    bounds.left + bounds.width / 2 <= viewport.width / 2 ? 'left' : 'right'
  const anchorY: FloatingTerminalPanelAnchorY =
    bounds.top + bounds.height / 2 <= viewport.height / 2 ? 'top' : 'bottom'
  return {
    anchorX,
    anchorY,
    offsetX: anchorX === 'left' ? bounds.left : viewport.width - bounds.left - bounds.width,
    offsetY: anchorY === 'top' ? bounds.top : viewport.height - bounds.top - bounds.height,
    width: bounds.width,
    height: bounds.height
  }
}

export function shouldReconcileFloatingTerminalPanelBounds(
  source: FloatingTerminalPanelBoundsSource
): boolean {
  return source === 'default' || hasUsableFloatingTerminalPanelViewport()
}

export function resolveFloatingTerminalPanelBounds(
  bounds: FloatingTerminalPanelCommittedBounds,
  source: FloatingTerminalPanelBoundsSource
): FloatingTerminalPanelBounds {
  if (source === 'default') {
    return getDefaultFloatingTerminalBounds()
  }
  return clampFloatingTerminalBounds(resolveFloatingTerminalPanelCommittedBounds(bounds))
}

export function parseFloatingTerminalPanelBounds(
  serialized: string | null
): FloatingTerminalPanelCommittedBounds | null {
  if (!serialized) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Record<string, unknown>
    if (isFiniteCoordinate(record.width) && isFiniteCoordinate(record.height)) {
      if (
        isAnchorX(record.anchorX) &&
        isAnchorY(record.anchorY) &&
        isFiniteCoordinate(record.offsetX) &&
        isFiniteCoordinate(record.offsetY)
      ) {
        return {
          anchorX: record.anchorX,
          anchorY: record.anchorY,
          offsetX: record.offsetX,
          offsetY: record.offsetY,
          width: record.width,
          height: record.height
        }
      }
      if (isFiniteCoordinate(record.left) && isFiniteCoordinate(record.top)) {
        return {
          left: record.left,
          top: record.top,
          width: record.width,
          height: record.height
        }
      }
    }
    return null
  } catch {
    return null
  }
}

export function readPersistedFloatingTerminalPanelBounds(): FloatingTerminalPanelCommittedBounds | null {
  try {
    return parseFloatingTerminalPanelBounds(
      getWindowStorage()?.getItem(FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY) ?? null
    )
  } catch {
    return null
  }
}

export function persistFloatingTerminalPanelBounds(
  bounds: FloatingTerminalPanelCommittedBounds
): void {
  try {
    getWindowStorage()?.setItem(FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY, JSON.stringify(bounds))
  } catch {
    // localStorage may be unavailable; the floating workspace remains session-local.
  }
}
