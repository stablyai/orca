import type { Terminal } from '@xterm/xterm'
import { clampTerminalViewport } from '../../../../shared/terminal-viewport'
import { terminalPreviewApiFor } from './terminal-preview-api'

const FIT_REQUEST_DEBOUNCE_MS = 200
/** Claim the dialog-sized PTY grid once per target size; unchanged requests must not fight a host or phone reclaiming geometry. */
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
    const { cols, rows } = clampTerminalViewport(
      Math.floor(box.clientWidth / cellWidth),
      Math.floor(box.clientHeight / cellHeight)
    )
    const fitKey = `${cols}x${rows}`
    if (fitKey === lastRequestedFit) {
      return
    }
    lastRequestedFit = fitKey
    // Successful claims trigger resync with the new grid; rejected claims keep the scaled fallback correct.
    void terminalPreviewApiFor(args.ptyId)
      .fit(args.ptyId, cols, rows)
      .catch(() => undefined)
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
