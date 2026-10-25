const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const LEGACY_MOUSE_WHEEL_DELTA_MIN = 100
const LEGACY_MOUSE_WHEEL_DELTA_UNIT = 120
const CONTINUOUS_WHEEL_GESTURE_IDLE_MS = 300
// Chromium's wheelDelta per CSS px for continuous devices: 3 on macOS, 1 on Windows/Linux.
const CONTINUOUS_WHEEL_LEGACY_RATIOS = [3, 1]
const CONTINUOUS_WHEEL_LEGACY_TOLERANCE = 3
const DEFAULT_TERMINAL_CELL_HEIGHT = 16
const TUI_WHEEL_ACCELERATED_DISTANCE_GAIN = 1.6
const TUI_WHEEL_BURST_FULL_INTERVAL_MS = 16
const TUI_WHEEL_BURST_MAX_INTERVAL_MS = 45
const TUI_WHEEL_BURST_MAX_BONUS_ROWS = 3
const TUI_WHEEL_BURST_RAMP_EVENTS = 4
const TUI_WHEEL_MOMENTUM_TAIL_DECAY_RATIO = 0.85
const TUI_WHEEL_COMPRESSED_MAX_DISTANCE_ROWS_PER_EVENT = 6
const TUI_WHEEL_BURST_MAX_DISTANCE_ROWS_PER_EVENT = 9

export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER = 1
export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN = 1
export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX = 10

type WheelEventWithLegacyDelta = WheelEvent & {
  wheelDelta?: number
  wheelDeltaY?: number
}

type TerminalTuiWheelEventInput = Pick<WheelEvent, 'deltaY'> &
  Partial<Pick<WheelEvent, 'deltaMode' | 'timeStamp'>> & {
    wheelDelta?: number
    wheelDeltaY?: number
  }

type TerminalTuiMouseWheelMetrics = {
  cellHeight?: number
  rows?: number
}

export type TerminalTuiMouseWheelDistanceState = {
  continuousGestureAt: number | null
  fastStreak: number
  lastDistanceRows: number | null
  lastInputAt: number | null
  pendingDirection: -1 | 0 | 1
  pendingRows: number
}

export function createTerminalTuiMouseWheelDistanceState(): TerminalTuiMouseWheelDistanceState {
  return {
    continuousGestureAt: null,
    fastStreak: 0,
    lastDistanceRows: null,
    lastInputAt: null,
    pendingDirection: 0,
    pendingRows: 0
  }
}

export function resolveTerminalWheelDirection(event: Pick<WheelEvent, 'deltaY'>): -1 | 1 {
  return event.deltaY < 0 ? -1 : 1
}

function legacyVerticalWheelDelta(event: TerminalTuiWheelEventInput): number | null {
  const wheelEvent = event as WheelEventWithLegacyDelta
  if (typeof wheelEvent.wheelDeltaY === 'number' && Number.isFinite(wheelEvent.wheelDeltaY)) {
    return wheelEvent.wheelDeltaY
  }
  if (typeof wheelEvent.wheelDelta === 'number' && Number.isFinite(wheelEvent.wheelDelta)) {
    return wheelEvent.wheelDelta
  }
  return null
}

function wheelInputTime(event: TerminalTuiWheelEventInput): number | null {
  if (typeof event.timeStamp === 'number' && Number.isFinite(event.timeStamp)) {
    return event.timeStamp
  }
  return null
}

function matchesContinuousWheelDeltaRatio(
  event: TerminalTuiWheelEventInput,
  legacyDelta: number
): boolean {
  return CONTINUOUS_WHEEL_LEGACY_RATIOS.some(
    (ratio) =>
      Math.abs(Math.abs(event.deltaY) * ratio - Math.abs(legacyDelta)) <=
      CONTINUOUS_WHEEL_LEGACY_TOLERANCE
  )
}

// Why: a small wheelDelta can only come from a continuous device, but a fast
// trackpad event can reach a notch-sized one (a Mac trackpad reports -3 x deltaY).
// Native terminals get a per-device precision flag that is constant across a
// gesture; emulate that by keeping the gesture continuous while large events keep
// the continuous delta shape, which a notch (4-40 px or 100 px per 120) does not.
function resolveContinuousWheelGesture(
  event: TerminalTuiWheelEventInput,
  state: TerminalTuiMouseWheelDistanceState
): boolean {
  if ((event.deltaMode ?? DOM_DELTA_PIXEL) !== DOM_DELTA_PIXEL) {
    state.continuousGestureAt = null
    return false
  }
  const inputAt = wheelInputTime(event)
  const legacyDelta = legacyVerticalWheelDelta(event)
  const continuous =
    legacyDelta === null ||
    Math.abs(legacyDelta) < LEGACY_MOUSE_WHEEL_DELTA_MIN ||
    (inputAt !== null &&
      state.continuousGestureAt !== null &&
      inputAt >= state.continuousGestureAt &&
      inputAt - state.continuousGestureAt <= CONTINUOUS_WHEEL_GESTURE_IDLE_MS &&
      matchesContinuousWheelDeltaRatio(event, legacyDelta))
  state.continuousGestureAt = continuous ? inputAt : null
  return continuous
}

function normalizeCellHeight(cellHeight: number | undefined): number {
  if (typeof cellHeight === 'number' && Number.isFinite(cellHeight) && cellHeight > 0) {
    return cellHeight
  }
  return DEFAULT_TERMINAL_CELL_HEIGHT
}

function resolveWheelDistanceRows(
  event: TerminalTuiWheelEventInput,
  metrics: TerminalTuiMouseWheelMetrics,
  continuous: boolean
): number {
  const deltaMode = event.deltaMode ?? DOM_DELTA_PIXEL
  const deltaY = Math.abs(event.deltaY)
  const rowsFromDelta =
    deltaMode === DOM_DELTA_LINE
      ? deltaY
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * Math.max(1, metrics.rows ?? 1)
        : deltaY / normalizeCellHeight(metrics.cellHeight)
  if (continuous) {
    return rowsFromDelta
  }
  const legacyDelta = legacyVerticalWheelDelta(event)
  const rowsFromLegacy =
    legacyDelta === null ? 0 : Math.abs(legacyDelta) / LEGACY_MOUSE_WHEEL_DELTA_UNIT
  return Math.max(1, rowsFromDelta, rowsFromLegacy)
}

function compressWheelDistanceRows(rows: number): number {
  if (rows <= 1) {
    return rows
  }

  return Math.min(
    TUI_WHEEL_COMPRESSED_MAX_DISTANCE_ROWS_PER_EVENT,
    1 + Math.log2(rows) * TUI_WHEEL_ACCELERATED_DISTANCE_GAIN
  )
}

function resolveBurstWheelDistanceRows(
  event: TerminalTuiWheelEventInput,
  state: TerminalTuiMouseWheelDistanceState,
  distanceRows: number
): number {
  const currentInputAt = wheelInputTime(event)
  if (currentInputAt === null) {
    state.fastStreak = 0
    state.lastDistanceRows = null
    state.lastInputAt = null
    return 0
  }

  const elapsedMs = state.lastInputAt === null ? null : currentInputAt - state.lastInputAt
  const isMomentumTail =
    state.lastDistanceRows !== null &&
    distanceRows < state.lastDistanceRows * TUI_WHEEL_MOMENTUM_TAIL_DECAY_RATIO
  state.lastDistanceRows = distanceRows
  state.lastInputAt = currentInputAt

  if (
    isMomentumTail ||
    elapsedMs === null ||
    elapsedMs < 0 ||
    elapsedMs > TUI_WHEEL_BURST_MAX_INTERVAL_MS
  ) {
    state.fastStreak = 0
    return 0
  }

  const cadence =
    elapsedMs <= TUI_WHEEL_BURST_FULL_INTERVAL_MS
      ? 1
      : (TUI_WHEEL_BURST_MAX_INTERVAL_MS - elapsedMs) /
        (TUI_WHEEL_BURST_MAX_INTERVAL_MS - TUI_WHEEL_BURST_FULL_INTERVAL_MS)
  state.fastStreak = Math.min(TUI_WHEEL_BURST_RAMP_EVENTS, state.fastStreak + 1)

  return TUI_WHEEL_BURST_MAX_BONUS_ROWS * cadence * (state.fastStreak / TUI_WHEEL_BURST_RAMP_EVENTS)
}

// Why: continuous pixel streams map 1:1 to physical distance: one report per
// terminal row scrolled, fractional remainder carried. No per-event cap and
// no momentum-tail suppression: the input write queue batches whatever a
// busy frame accumulates into a single PTY write, so the TUI applies it at
// once instead of replaying it, and inertial scrolling stays real-time.
function resolveContinuousWheelReportCount(
  state: TerminalTuiMouseWheelDistanceState,
  distanceRows: number
): number {
  state.fastStreak = 0
  state.lastDistanceRows = null
  state.lastInputAt = null
  const totalRows = state.pendingRows + distanceRows
  const reports = Math.trunc(totalRows)
  state.pendingRows = totalRows - reports
  return reports
}

export function normalizeTerminalTuiMouseWheelMultiplier(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER
  }
  return Math.round(
    Math.min(
      TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX,
      Math.max(TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN, value)
    )
  )
}

export function resolveTerminalTuiMouseWheelReportCount(
  event: TerminalTuiWheelEventInput,
  multiplier: number,
  state: TerminalTuiMouseWheelDistanceState,
  metrics: TerminalTuiMouseWheelMetrics = {}
): number {
  const direction = resolveTerminalWheelDirection(event)
  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.fastStreak = 0
    state.lastDistanceRows = null
    state.lastInputAt = null
    state.pendingRows = 0
  }
  state.pendingDirection = direction

  const continuous = resolveContinuousWheelGesture(event, state)
  const distanceRows = resolveWheelDistanceRows(event, metrics, continuous)
  if (continuous) {
    return resolveContinuousWheelReportCount(state, distanceRows)
  }

  const rows =
    Math.min(
      TUI_WHEEL_BURST_MAX_DISTANCE_ROWS_PER_EVENT,
      compressWheelDistanceRows(distanceRows) +
        resolveBurstWheelDistanceRows(event, state, distanceRows)
    ) * normalizeTerminalTuiMouseWheelMultiplier(multiplier)
  const totalRows = state.pendingRows + rows
  const reports = Math.trunc(totalRows)
  state.pendingRows = totalRows - reports
  return reports
}
