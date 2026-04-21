import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'

// ---------------------------------------------------------------------------
// Scroll restoration after reflow
// ---------------------------------------------------------------------------

// Why: xterm.js does NOT adjust viewportY for partially-scrolled buffers
// during resize/reflow. Line N before reflow shows different content than
// line N after reflow when wrapping changes (e.g. 80→40 cols makes each
// line wrap to 2 rows). To preserve the user's scroll position, we find
// the buffer line whose content matches what was at the top of the viewport
// before the reflow, then scroll to it.
//
// Why hintRatio: terminals frequently contain duplicate short lines (shell
// prompts, repeated log prefixes). A prefix-only search returns the first
// match which may be far from the actual scroll position. The proportional
// hint (viewportY / totalLines before reflow) disambiguates by preferring
// the match closest to the expected position in the reflowed buffer.
export function findLineByContent(terminal: Terminal, content: string, hintRatio?: number): number {
  if (!content) {
    return -1
  }
  const buf = terminal.buffer.active
  const totalLines = buf.baseY + terminal.rows
  const prefix = content.substring(0, Math.min(content.length, 40))
  if (!prefix) {
    return -1
  }

  const hintLine = hintRatio !== undefined ? Math.round(hintRatio * totalLines) : -1

  let bestMatch = -1
  let bestDistance = Infinity

  for (let i = 0; i < totalLines; i++) {
    const line = buf.getLine(i)?.translateToString(true)?.trimEnd() ?? ''
    if (line.startsWith(prefix)) {
      if (hintLine < 0) {
        return i
      }
      const distance = Math.abs(i - hintLine)
      if (distance < bestDistance) {
        bestDistance = distance
        bestMatch = i
      }
    }
  }
  return bestMatch
}

export function captureScrollState(terminal: Terminal): ScrollState {
  const buf = terminal.buffer.active
  const viewportY = buf.viewportY
  const wasAtBottom = viewportY >= buf.baseY
  const totalLines = buf.baseY + terminal.rows

  // Why: if the viewport starts at a wrapped continuation row, its content
  // won't appear as a line start after reflow (column count change shifts
  // wrap points). Walk backward to the logical line start — that content
  // always remains a line start regardless of column width, making content
  // matching reliable for long-line terminals like Claude Code.
  let anchorY = viewportY
  while (anchorY > 0 && buf.getLine(anchorY)?.isWrapped) {
    anchorY--
  }
  const firstVisibleLineContent = buf.getLine(anchorY)?.translateToString(true)?.trimEnd() ?? ''
  const logicalLineOffset = viewportY - anchorY

  return {
    wasAtBottom,
    firstVisibleLineContent,
    viewportY,
    totalLines,
    cols: terminal.cols,
    logicalLineOffset
  }
}

export function restoreScrollState(terminal: Terminal, state: ScrollState): void {
  if (state.wasAtBottom) {
    terminal.scrollToBottom()
    forceViewportScrollbarSync(terminal)
    return
  }
  const hintRatio = state.totalLines > 0 ? state.viewportY / state.totalLines : undefined
  const target = findLineByContent(terminal, state.firstVisibleLineContent, hintRatio)
  if (target >= 0) {
    // Why: the anchor may be the logical line start (several wrapped rows
    // above the actual viewport row). After reflow the logical line may
    // wrap into fewer or more rows. Scale the offset by the column ratio
    // to approximate the new wrap count, then add it to the matched line.
    let scrollTarget = target
    if (state.logicalLineOffset > 0) {
      const newCols = terminal.cols
      const scaledOffset =
        state.cols > 0 && newCols > 0
          ? Math.round(state.logicalLineOffset * (state.cols / newCols))
          : state.logicalLineOffset
      scrollTarget = Math.min(target + scaledOffset, terminal.buffer.active.baseY)
    }
    terminal.scrollToLine(scrollTarget)
    forceViewportScrollbarSync(terminal)
    return
  }
  // Why: content matching fails when the first visible line is blank or when
  // reflow changes content beyond recognition. Without a fallback, the
  // terminal stays wherever xterm.js left it after the reflow — often the
  // top. Proportional positioning approximates the original scroll position
  // by mapping the old ratio into the new buffer dimensions.
  if (hintRatio !== undefined) {
    const newTotalLines = terminal.buffer.active.baseY + terminal.rows
    const fallbackLine = Math.round(hintRatio * newTotalLines)
    const clampedLine = Math.min(fallbackLine, terminal.buffer.active.baseY)
    terminal.scrollToLine(clampedLine)
    forceViewportScrollbarSync(terminal)
  }
}

// Why: xterm 6's Viewport._sync() updates scrollDimensions after resize but
// skips the scrollPosition update when ydisp matches _latestYDisp (a stale
// internal value). This leaves the scrollbar thumb at a wrong position even
// though the rendered content is correct.
//
// Immediate jiggle: scrollLines(-1/+1) triggers _sync with a differing ydisp,
// which calls setScrollPosition. This fixes the common case in the same JS turn.
//
// Why double-rAF: fit() queues an async _sync() via addRefreshCallback, which
// fires AFTER the renderer's rAF. That _sync calls setScrollDimensions with a
// new (potentially smaller) scrollHeight, causing the SmoothScrollableElement to
// clamp scrollTop. But _sync skips setScrollPosition because _latestYDisp was
// never updated to the new target (the Viewport's _handleScroll sees diff=0
// after each scrollToLine because buffer.ydisp already matches). A single rAF
// may fire before the render's refresh callback, so a double-rAF guarantees we
// run after _sync has settled. Re-applying scrollToLine forces a new _sync with
// the correct ydisp, which calls setScrollPosition (ydisp !== stale _latestYDisp).
function forceViewportScrollbarSync(terminal: Terminal): void {
  jiggleScroll(terminal)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        const buf = terminal.buffer.active
        if (buf.viewportY < buf.baseY) {
          terminal.scrollToLine(buf.viewportY)
        }
      } catch {
        /* terminal may have been disposed */
      }
    })
  })
}

function jiggleScroll(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY > 0) {
    terminal.scrollLines(-1)
    terminal.scrollLines(1)
  } else if (buf.viewportY < buf.baseY) {
    terminal.scrollLines(1)
    terminal.scrollLines(-1)
  }
}
