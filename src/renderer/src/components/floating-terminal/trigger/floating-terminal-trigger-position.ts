const TRIGGER_SIZE = 36
const DEFAULT_RIGHT_GAP = 24
const DEFAULT_BOTTOM_GAP = 72
const DRAG_MARGIN = 8
const TITLEBAR_SAFE_TOP = 36
const KEEP_CLEAR_GAP = 8

export const FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY =
  'orca-floating-terminal-trigger-position-v2'

export type FloatingTerminalTriggerPosition = {
  left: number
  top: number
}

export type FloatingTerminalAnchorX = 'left' | 'right'
export type FloatingTerminalAnchorY = 'top' | 'bottom'

export type FloatingTerminalAnchoredTriggerPosition = {
  anchorX: FloatingTerminalAnchorX
  anchorY: FloatingTerminalAnchorY
  offsetX: number
  offsetY: number
}

export type FloatingTerminalTriggerCommittedPosition =
  | FloatingTerminalTriggerPosition
  | FloatingTerminalAnchoredTriggerPosition

export type FloatingTerminalTriggerPositionSource = 'default' | 'user'

export type FloatingTerminalTriggerKeepClearRect = {
  left: number
  top: number
  right: number
  bottom: number
  /** Bottom of the pane holding the box: the button may only go below the box above this. */
  paneBottom: number
}

function getViewport(): { width: number; height: number } {
  return {
    width: typeof window === 'undefined' ? 1200 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight
  }
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAnchorX(value: unknown): value is FloatingTerminalAnchorX {
  return value === 'left' || value === 'right'
}

function isAnchorY(value: unknown): value is FloatingTerminalAnchorY {
  return value === 'top' || value === 'bottom'
}

function getWindowStorage(): Storage | null {
  return typeof window !== 'undefined' && window.localStorage !== undefined
    ? window.localStorage
    : null
}

function isAnchoredTriggerPosition(
  position: FloatingTerminalTriggerCommittedPosition
): position is FloatingTerminalAnchoredTriggerPosition {
  return 'anchorX' in position
}

export function getDefaultFloatingTerminalTriggerCommittedPosition(): FloatingTerminalAnchoredTriggerPosition {
  const narrow = getViewport().width < 440
  return {
    anchorX: 'right',
    anchorY: narrow ? 'top' : 'bottom',
    offsetX: DEFAULT_RIGHT_GAP,
    offsetY: narrow ? TITLEBAR_SAFE_TOP + TRIGGER_SIZE : DEFAULT_BOTTOM_GAP
  }
}

export function getDefaultFloatingTerminalTriggerPosition(): FloatingTerminalTriggerPosition {
  return clampFloatingTerminalTriggerPosition(
    resolveFloatingTerminalTriggerCommittedPosition(
      getDefaultFloatingTerminalTriggerCommittedPosition()
    )
  )
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

/** Where the button shows: its own spot, or the nearest clear spot below, else above, a page part it would cover. */
export function keepFloatingTerminalTriggerClear(
  position: FloatingTerminalTriggerPosition,
  keepClear: readonly FloatingTerminalTriggerKeepClearRect[]
): FloatingTerminalTriggerPosition {
  const covers = (top: number, rect: FloatingTerminalTriggerKeepClearRect): boolean =>
    position.left < rect.right &&
    position.left + TRIGGER_SIZE > rect.left &&
    top < rect.bottom &&
    top + TRIGGER_SIZE > rect.top
  const covered = keepClear.filter((rect) => covers(position.top, rect))
  if (covered.length === 0) {
    return position
  }
  // Below a covered box first, then above it, then beside the others: moving off one box can land on another.
  const spots = [...covered, ...keepClear.filter((rect) => !covered.includes(rect))].flatMap(
    (rect) => {
      const below = rect.bottom + KEEP_CLEAR_GAP
      // The pane may run past the window, which the button must stay inside too.
      const floor = Math.min(rect.paneBottom, getViewport().height) - DRAG_MARGIN
      const above = rect.top - KEEP_CLEAR_GAP - TRIGGER_SIZE
      return below + TRIGGER_SIZE <= floor ? [below, above] : [above]
    }
  )
  const lowest = getViewport().height - TRIGGER_SIZE - DRAG_MARGIN
  // A spot the window clamp would move could land back on a box, so only spots it keeps count.
  const clear = spots.find(
    (top) =>
      top >= TITLEBAR_SAFE_TOP && top <= lowest && !keepClear.some((rect) => covers(top, rect))
  )
  return clampFloatingTerminalTriggerPosition({ left: position.left, top: clear ?? spots[0] })
}

export function hasUsableFloatingTerminalTriggerViewport(): boolean {
  const viewport = getViewport()
  return (
    viewport.width >= TRIGGER_SIZE + DRAG_MARGIN * 2 &&
    viewport.height >= TRIGGER_SIZE + TITLEBAR_SAFE_TOP + DRAG_MARGIN
  )
}

export function resolveFloatingTerminalTriggerCommittedPosition(
  position: FloatingTerminalTriggerCommittedPosition
): FloatingTerminalTriggerPosition {
  if (!isAnchoredTriggerPosition(position)) {
    return position
  }
  const viewport = getViewport()
  return {
    left:
      position.anchorX === 'left'
        ? position.offsetX
        : viewport.width - TRIGGER_SIZE - position.offsetX,
    top:
      position.anchorY === 'top'
        ? position.offsetY
        : viewport.height - TRIGGER_SIZE - position.offsetY
  }
}

export function anchorFloatingTerminalTriggerPosition(
  position: FloatingTerminalTriggerPosition
): FloatingTerminalAnchoredTriggerPosition | null {
  if (!hasUsableFloatingTerminalTriggerViewport()) {
    return null
  }
  const viewport = getViewport()
  const anchorX: FloatingTerminalAnchorX =
    position.left + TRIGGER_SIZE / 2 <= viewport.width / 2 ? 'left' : 'right'
  const anchorY: FloatingTerminalAnchorY =
    position.top + TRIGGER_SIZE / 2 <= viewport.height / 2 ? 'top' : 'bottom'
  return {
    anchorX,
    anchorY,
    offsetX: anchorX === 'left' ? position.left : viewport.width - position.left - TRIGGER_SIZE,
    offsetY: anchorY === 'top' ? position.top : viewport.height - position.top - TRIGGER_SIZE
  }
}

export function shouldReconcileFloatingTerminalTriggerPosition(
  source: FloatingTerminalTriggerPositionSource
): boolean {
  return source === 'default' || hasUsableFloatingTerminalTriggerViewport()
}

export function resolveFloatingTerminalTriggerPosition(
  position: FloatingTerminalTriggerCommittedPosition,
  source: FloatingTerminalTriggerPositionSource
): FloatingTerminalTriggerPosition {
  if (source === 'default') {
    return getDefaultFloatingTerminalTriggerPosition()
  }
  return clampFloatingTerminalTriggerPosition(
    resolveFloatingTerminalTriggerCommittedPosition(position)
  )
}

export function parseFloatingTerminalTriggerPosition(
  serialized: string | null
): FloatingTerminalTriggerCommittedPosition | null {
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
      isAnchorX(record.anchorX) &&
      isAnchorY(record.anchorY) &&
      isFiniteCoordinate(record.offsetX) &&
      isFiniteCoordinate(record.offsetY)
    ) {
      return {
        anchorX: record.anchorX,
        anchorY: record.anchorY,
        offsetX: record.offsetX,
        offsetY: record.offsetY
      }
    }
    if (!isFiniteCoordinate(record.left) || !isFiniteCoordinate(record.top)) {
      return null
    }
    return { left: record.left, top: record.top }
  } catch {
    return null
  }
}

export function readPersistedFloatingTerminalTriggerPosition(): FloatingTerminalTriggerCommittedPosition | null {
  try {
    return parseFloatingTerminalTriggerPosition(
      getWindowStorage()?.getItem(FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY) ?? null
    )
  } catch {
    return null
  }
}

export function persistFloatingTerminalTriggerPosition(
  position: FloatingTerminalTriggerCommittedPosition
): void {
  try {
    getWindowStorage()?.setItem(
      FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY,
      JSON.stringify(position)
    )
  } catch {
    // localStorage may be unavailable; the floating launcher remains session-local.
  }
}
