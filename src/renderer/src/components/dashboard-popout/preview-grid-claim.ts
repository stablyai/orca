import type { Terminal } from '@xterm/xterm'

const FIT_REQUEST_DEBOUNCE_MS = 200
// Mirror the runtime's clampTerminalViewport so a request always matches what lands.
const FIT_MIN_COLS = 20
const FIT_MAX_COLS = 240
const FIT_MIN_ROWS = 8
const FIT_MAX_ROWS = 120

function clampGridAxis(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Negotiates the PTY grid for the popout terminal dialog: measures the live
 * terminal's cell size, computes the grid the dialog box can hold, and asks
 * main to claim it (remote-desktop viewer machinery — the main-window pane
 * parks at the claimed grid and reclaims its own geometry once the claim is
 * released). Requests are keyed by target dims and never re-sent for an
 * unchanged target, so a host or phone taking the grid back doesn't start a
 * resize tug-of-war.
 */
export function createPreviewGridClaim(args: {
  ptyId: string
  container: HTMLElement
  getTerminal: () => Terminal | null
}): { schedule: () => void; dispose: () => void } {
  let lastRequestedFit: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const request = (): void => {
    const terminal = args.getTerminal()
    if (disposed || !terminal) {
      return
    }
    const screen = args.container.querySelector<HTMLElement>('.xterm-screen')
    const box = args.container.parentElement
    if (!screen || !box) {
      return
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
      return
    }
    const cols = clampGridAxis(Math.floor(box.clientWidth / cellWidth), FIT_MIN_COLS, FIT_MAX_COLS)
    const rows = clampGridAxis(
      Math.floor(box.clientHeight / cellHeight),
      FIT_MIN_ROWS,
      FIT_MAX_ROWS
    )
    const fitKey = `${cols}x${rows}`
    if (fitKey === lastRequestedFit) {
      return
    }
    lastRequestedFit = fitKey
    // The resize triggers a main-side resync push; the reconnect snapshot
    // carries the new grid. If the claim didn't land (a phone owns the size),
    // the dialog's scaled fallback rendering stays correct as-is.
    void window.api.terminalPreview.fit(args.ptyId, cols, rows).catch(() => undefined)
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
      request()
    }, FIT_REQUEST_DEBOUNCE_MS)
  }

  return {
    schedule,
    dispose: (): void => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
