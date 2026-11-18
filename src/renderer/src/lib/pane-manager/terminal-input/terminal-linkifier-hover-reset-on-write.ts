import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  isTerminalLinkifierHoverActive,
  refreshStaleTerminalLinkifierHover,
  resetTerminalLinkifierHoverState
} from './terminal-linkifier-hover-reset'

// Coalesce resets to 150ms windows so streamed links recover on pointer movement without per-chunk provider churn.
const HOVER_RESET_THROTTLE_MS = 150

/** xterm caches providers per buffer cell/line without content invalidation; streamed URLs under a stationary pointer otherwise stay dead until it changes lines. Reset after output so the next move relinks, complementing visibility-resume resets. */
export function installTerminalLinkifierHoverResetOnWrite(terminal: Terminal): IDisposable {
  // If onWriteParsed is unavailable, preserve pane creation and let links recover on a genuine cell change.
  if (typeof terminal.onWriteParsed !== 'function') {
    return { dispose: () => undefined }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (refreshStaleTerminalLinkifierHover(terminal)) {
      timer = null
      return
    }
    // Defer while hovering to avoid async underline/tooltip flicker, retaining one retry until hover ends. Dropping it after the final chunk would leave appended links dead without further output.
    if (isTerminalLinkifierHoverActive(terminal)) {
      timer = setTimeout(flush, HOVER_RESET_THROTTLE_MS)
      return
    }
    timer = null
    resetTerminalLinkifierHoverState(terminal)
  }
  const scheduleReset = (): void => {
    if (timer !== null) {
      return
    }
    timer = setTimeout(flush, HOVER_RESET_THROTTLE_MS)
  }
  const writeParsedDisposable = terminal.onWriteParsed(scheduleReset)
  return {
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      writeParsedDisposable.dispose()
    }
  }
}
