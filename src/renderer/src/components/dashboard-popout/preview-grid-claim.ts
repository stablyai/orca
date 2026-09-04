import type { Terminal } from '@xterm/xterm'

const FIT_REQUEST_DEBOUNCE_MS = 200
// Mirror the runtime's clampTerminalViewport so a request always matches what lands.
const FIT_MIN_COLS = 20
const FIT_MAX_COLS = 240
const FIT_MIN_ROWS = 8
const FIT_MAX_ROWS = 120

export type PreviewGridSize = { cols: number; rows: number }

/**
 * Outcome of the last claim for a given target grid.
 * - `settled`: the PTY is at the requested grid; the frame renders 1:1.
 * - `unreachable`: the runtime clamped the request, another viewer owns the
 *   grid, or the resize failed. Re-asking cannot change it, so the request is
 *   not repeated and the scale-to-fit fallback is the answer.
 */
type ClaimStatus = 'open' | 'settled' | 'unreachable'

type ClaimEpoch = { target: string; status: ClaimStatus }

function clampGridAxis(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Negotiates the PTY grid for a preview surface: measures the live terminal's
 * cell size, computes the grid its box can hold, and asks main to claim it
 * (remote-desktop viewer machinery — the main-window pane parks at the claimed
 * grid and reclaims its own geometry once the claim is released).
 *
 * Requests are keyed by target dims and never re-sent for an unchanged target,
 * so a host or phone taking the grid back doesn't start a resize tug-of-war.
 * Main answers with the size actually in effect, which is tracked separately
 * from the size asked for: a clamped or seized claim must not read as success,
 * or the surface sits at a geometry it never verified.
 */
export function createPreviewGridClaim(args: {
  ptyId: string
  surfaceId: string
  container: HTMLElement
  getTerminal: () => Terminal | null
  /** Notified with the grid actually in effect, or null when the claim did not land. */
  onApplied?: (applied: PreviewGridSize | null) => void
}): {
  schedule: () => void
  getApplied: () => PreviewGridSize | null
  /** A snapshot proved the PTY is at this grid (another viewer resized it); measure fallbacks against it. */
  noteAppliedFromSnapshot: (cols: number, rows: number) => void
  dispose: () => void
} {
  let epoch: ClaimEpoch | null = null
  let applied: PreviewGridSize | null = null
  let inFlight = false
  // A request that arrived mid-flight; re-measured once the claim settles so a
  // box change during the IPC is not dropped until the next unrelated change.
  let followUpPending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const measure = (): PreviewGridSize | null => {
    const terminal = args.getTerminal()
    if (!terminal) {
      return null
    }
    const screen = args.container.querySelector<HTMLElement>('.xterm-screen')
    const box = args.container.parentElement
    if (!screen || !box) {
      return null
    }
    // offsetWidth/Height are layout dims, unaffected by the scale transform.
    const cellWidth = screen.offsetWidth / Math.max(1, terminal.cols)
    const cellHeight = screen.offsetHeight / Math.max(1, terminal.rows)
    if (
      !Number.isFinite(cellWidth) ||
      !Number.isFinite(cellHeight) ||
      cellWidth <= 0 ||
      cellHeight <= 0 ||
      box.clientWidth <= 0 ||
      box.clientHeight <= 0
    ) {
      return null
    }
    return {
      cols: clampGridAxis(Math.floor(box.clientWidth / cellWidth), FIT_MIN_COLS, FIT_MAX_COLS),
      rows: clampGridAxis(Math.floor(box.clientHeight / cellHeight), FIT_MIN_ROWS, FIT_MAX_ROWS)
    }
  }

  const request = async (): Promise<void> => {
    if (disposed) {
      return
    }
    if (inFlight) {
      followUpPending = true
      return
    }
    const target = measure()
    if (!target) {
      return
    }
    const targetKey = `${target.cols}x${target.rows}`
    if (epoch?.target === targetKey) {
      return
    }
    epoch = { target: targetKey, status: 'open' }
    inFlight = true
    // The resize triggers a main-side resync push; the reconnect snapshot
    // carries the new grid.
    const landed = await window.api.terminalPreview
      .fit(args.ptyId, target.cols, target.rows, args.surfaceId)
      .catch(() => null)
    inFlight = false
    if (disposed || epoch?.target !== targetKey) {
      return
    }
    applied = landed
    settle(target, landed)
    // One follow-up, no loop: the re-measure dedupes against the target just settled.
    if (followUpPending) {
      followUpPending = false
      void request()
    }
  }

  const settle = (target: PreviewGridSize, landed: PreviewGridSize | null): void => {
    if (!epoch) {
      return
    }
    // Why compare rather than trust: main clamps to the PTY's supported range
    // and the viewer registry hands the grid to whoever claimed last, so a
    // request can succeed at a size that is not the one asked for. Recording
    // the requested size as done is what previously left a card convinced it
    // was 1:1 while rendering at another geometry.
    epoch.status =
      landed && landed.cols === target.cols && landed.rows === target.rows
        ? 'settled'
        : 'unreachable'
    // Observable claim state: what E2E asserts the "card fills its box" oracle on.
    args.container.dataset.claimRequested = epoch.target
    args.container.dataset.claimApplied = landed ? `${landed.cols}x${landed.rows}` : 'none'
    args.container.dataset.claimStatus = epoch.status
    args.onApplied?.(landed)
  }

  const noteAppliedFromSnapshot = (cols: number, rows: number): void => {
    if (disposed || inFlight) {
      return
    }
    applied = { cols, rows }
    args.container.dataset.claimApplied = `${cols}x${rows}`
  }

  const schedule = (): void => {
    if (disposed) {
      return
    }
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      void request()
    }, FIT_REQUEST_DEBOUNCE_MS)
  }

  return {
    schedule,
    getApplied: () => applied,
    noteAppliedFromSnapshot,
    dispose: (): void => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
