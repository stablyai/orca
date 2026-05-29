const TRIGGER_SIZE = 32
const DEFAULT_RIGHT_GAP = 24
const DEFAULT_BOTTOM_GAP = 72
const DRAG_MARGIN = 8
const TITLEBAR_SAFE_TOP = 36

export type FloatingTerminalTriggerPosition = {
  left: number
  top: number
}

export type FloatingTerminalTriggerPositionSource = 'default' | 'user'

function getViewport(): { width: number; height: number } {
  return {
    width: typeof window === 'undefined' ? 1200 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight
  }
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function getDefaultFloatingTerminalTriggerPosition(): FloatingTerminalTriggerPosition {
  const viewport = getViewport()
  return {
    left: Math.max(DRAG_MARGIN, viewport.width - TRIGGER_SIZE - DEFAULT_RIGHT_GAP),
    top: Math.max(TITLEBAR_SAFE_TOP, viewport.height - TRIGGER_SIZE - DEFAULT_BOTTOM_GAP)
  }
}

export function clampFloatingTerminalTriggerPosition(
  position: FloatingTerminalTriggerPosition
): FloatingTerminalTriggerPosition {
  const viewport = getViewport()
  const maxLeft = Math.max(DRAG_MARGIN, viewport.width - TRIGGER_SIZE - DRAG_MARGIN)
  const maxTop = Math.max(TITLEBAR_SAFE_TOP, viewport.height - TRIGGER_SIZE - DRAG_MARGIN)
  return {
    left: Math.min(Math.max(DRAG_MARGIN, position.left), maxLeft),
    top: Math.min(Math.max(TITLEBAR_SAFE_TOP, position.top), maxTop)
  }
}

export function hasUsableFloatingTerminalTriggerViewport(): boolean {
  const viewport = getViewport()
  return (
    viewport.width >= TRIGGER_SIZE + DRAG_MARGIN * 2 &&
    viewport.height >= TRIGGER_SIZE + TITLEBAR_SAFE_TOP + DRAG_MARGIN
  )
}

export function shouldReconcileFloatingTerminalTriggerPosition(
  source: FloatingTerminalTriggerPositionSource
): boolean {
  return source === 'default' || hasUsableFloatingTerminalTriggerViewport()
}

export function resolveFloatingTerminalTriggerPosition(
  position: FloatingTerminalTriggerPosition,
  source: FloatingTerminalTriggerPositionSource
): FloatingTerminalTriggerPosition {
  if (source === 'default') {
    return getDefaultFloatingTerminalTriggerPosition()
  }
  return clampFloatingTerminalTriggerPosition(position)
}

export function parseFloatingTerminalTriggerPosition(
  serialized: string | null
): FloatingTerminalTriggerPosition | null {
  if (!serialized) {
    return null
  }
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    if (!isFiniteCoordinate(parsed.left) || !isFiniteCoordinate(parsed.top)) {
      return null
    }
    return { left: parsed.left, top: parsed.top }
  } catch {
    return null
  }
}
