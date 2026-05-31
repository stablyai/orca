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

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max)
}

function getWindowStorage(): Storage | null {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
    ? window.localStorage
    : null
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

export function shouldReconcileFloatingTerminalPanelBounds(
  source: FloatingTerminalPanelBoundsSource
): boolean {
  return source === 'default' || hasUsableFloatingTerminalPanelViewport()
}

export function resolveFloatingTerminalPanelBounds(
  bounds: FloatingTerminalPanelBounds,
  source: FloatingTerminalPanelBoundsSource
): FloatingTerminalPanelBounds {
  if (source === 'default') {
    return getDefaultFloatingTerminalBounds()
  }
  return clampFloatingTerminalBounds(bounds)
}

export function parseFloatingTerminalPanelBounds(
  serialized: string | null
): FloatingTerminalPanelBounds | null {
  if (!serialized) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Record<string, unknown>
    if (
      !isFiniteCoordinate(record.left) ||
      !isFiniteCoordinate(record.top) ||
      !isFiniteCoordinate(record.width) ||
      !isFiniteCoordinate(record.height)
    ) {
      return null
    }
    return {
      left: record.left,
      top: record.top,
      width: record.width,
      height: record.height
    }
  } catch {
    return null
  }
}

export function readPersistedFloatingTerminalPanelBounds(): FloatingTerminalPanelBounds | null {
  try {
    return parseFloatingTerminalPanelBounds(
      getWindowStorage()?.getItem(FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY) ?? null
    )
  } catch {
    return null
  }
}

export function persistFloatingTerminalPanelBounds(bounds: FloatingTerminalPanelBounds): void {
  try {
    getWindowStorage()?.setItem(FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY, JSON.stringify(bounds))
  } catch {
    // localStorage may be unavailable; the floating workspace remains session-local.
  }
}
