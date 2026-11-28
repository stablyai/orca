import type { Terminal } from '@xterm/xterm'
import { clampTerminalViewport } from '../../../../../../shared/terminal/viewport/terminal-viewport'
import { claimsRemoteDesktopViewportOnInput } from '@/components/terminal-pane/viewport/remote-desktop-viewport-claim'
import { terminalPreviewApiFor, terminalPreviewHoldMode } from '../transport/terminal-preview-api'

const FIT_REQUEST_DEBOUNCE_MS = 200

type Grid = { cols: number; rows: number }

/** Claim the dialog-sized PTY grid once per target size; unchanged requests must not fight a host or
 *  phone reclaiming geometry. With `onTyping` (another person's terminal), the paired-terminal rule:
 *  typing claims the grid, and only while this viewer holds it does its window's size follow. */
export function createPreviewGridClaim(args: {
  ptyId: string
  container: HTMLElement
  getTerminal: () => Pick<Terminal, 'cols' | 'rows'> | null
  onTyping?: boolean
}): { schedule: () => void; claimForInput: (data: string) => void; dispose: () => void } {
  let lastRequestedFit: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const measure = (): Grid | null => {
    const terminal = args.getTerminal()
    if (disposed || !terminal) {
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
    return clampTerminalViewport(
      Math.floor(box.clientWidth / cellWidth),
      Math.floor(box.clientHeight / cellHeight)
    )
  }

  const claim = (grid: Grid, again: boolean): void => {
    const fitKey = `${grid.cols}x${grid.rows}`
    if (!again && fitKey === lastRequestedFit) {
      return
    }
    lastRequestedFit = fitKey
    // Successful claims trigger resync with the new grid; rejected claims keep the scaled fallback correct.
    void terminalPreviewApiFor(args.ptyId)
      .fit(args.ptyId, grid.cols, grid.rows)
      .catch(() => undefined)
  }

  const request = (): void => {
    const grid = measure()
    if (!grid) {
      return
    }
    // Another person's terminal: a resize applies only while this viewer holds the grid.
    if (!args.onTyping || terminalPreviewHoldMode(args.ptyId) === 'desktop-fit') {
      claim(grid, false)
    }
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

  // Until the host says this viewer holds the grid, a peer does: each keystroke claims it again,
  // measured now. A holder's repeat claim is a no-op on the host's floor; this app's main process
  // never says who holds.
  const claimForInput = (data: string): void => {
    if (
      !args.onTyping ||
      !claimsRemoteDesktopViewportOnInput(
        terminalPreviewHoldMode(args.ptyId) ?? 'remote-desktop-fit',
        data
      )
    ) {
      return
    }
    const grid = measure()
    if (grid) {
      claim(grid, true)
    }
  }

  return {
    schedule,
    claimForInput,
    dispose: (): void => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
