import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  isTerminalLinkifierHoverActive,
  resetTerminalLinkifierHoverState
} from './terminal-linkifier-hover-reset'

// Why: coalesce bursts of streamed output into at most one hover-cache reset
// per window so continuous agent output does not force a provider re-query on
// every parsed chunk. 150ms keeps a freshly printed link responsive to the
// user's next pointer move without measurable churn.
const HOVER_RESET_THROTTLE_MS = 150

/**
 * Invalidate xterm's linkifier hover cache shortly after streamed output lands.
 *
 * Why: xterm re-runs link providers only on mousemove when the hovered buffer
 * cell changes, and it caches provider replies per line with no content-change
 * invalidation ({@link resetTerminalLinkifierHoverState} documents the fields).
 * A URL an agent streams into a visible pane under a stationary pointer is
 * therefore never underlined — and its native activation stays dead — until the
 * pointer crosses to a different line, which is the "click the terminal a few
 * times before the link works" symptom. Clearing the cell/line cache when new
 * content lands lets the very next pointer move re-linkify the fresh URL.
 *
 * Sibling of the visibility-resume reset (see terminal-visibility-resume.ts),
 * which only covers reveal — not output streaming into an already-visible pane.
 */
export function installTerminalLinkifierHoverResetOnWrite(terminal: Terminal): IDisposable {
  // Why: never let this break pane creation if a Terminal stub or a future
  // xterm build lacks onWriteParsed — links then recover on the next cell
  // change, as they did before this reset existed.
  if (typeof terminal.onWriteParsed !== 'function') {
    return { dispose: () => undefined }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    // Why: never invalidate the cache while the user is hovering a link — it
    // would clear+re-query the active link (async for file paths), flickering
    // its underline/tooltip. Re-arm instead of dropping the pending reset: if
    // this was the last chunk of a burst and it appended a link to the hovered
    // line, dropping the reset would leave that link dead until a line change.
    // The retry performs the reset once the hover ends. (timer stays non-null
    // during the retry so a concurrent write does not stack a second timer.)
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
