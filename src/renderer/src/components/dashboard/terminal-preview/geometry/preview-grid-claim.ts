import type { Terminal } from '@xterm/xterm'
import { clampTerminalViewport } from '../../../../../../shared/terminal/viewport/terminal-viewport'
import { claimsRemoteDesktopViewportOnInput } from '@/components/terminal-pane/viewport/remote-desktop-viewport-claim'
import { terminalPreviewApiFor, terminalPreviewHoldMode } from '../transport/terminal-preview-api'

const FIT_REQUEST_DEBOUNCE_MS = 200
/** Claim the dialog-sized PTY grid once per target size; unchanged requests must not fight a host or
 *  phone reclaiming geometry. With `onTyping` (another person's terminal), the grid is only measured,
 *  and typing claims it by the paired-terminal rule. */
export function createPreviewGridClaim(args: {
  ptyId: string
  container: HTMLElement
  getTerminal: () => Pick<Terminal, 'cols' | 'rows'> | null
  onTyping?: boolean
}): { schedule: () => void; claimForInput: (data: string) => void; dispose: () => void } {
  let lastRequestedFit: string | null = null
  let measured: { cols: number; rows: number } | null = null
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
    if (args.onTyping) {
      measured = { cols, rows }
      return
    }
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

  // Until the host says this viewer holds the grid, a peer does; a holder's repeat claim is a no-op
  // on the host's floor, and this app's main process never says.
  const claimForInput = (data: string): void => {
    if (
      args.onTyping &&
      measured &&
      claimsRemoteDesktopViewportOnInput(
        terminalPreviewHoldMode(args.ptyId) ?? 'remote-desktop-fit',
        data
      )
    ) {
      void terminalPreviewApiFor(args.ptyId)
        .fit(args.ptyId, measured.cols, measured.rows)
        .catch(() => undefined)
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
