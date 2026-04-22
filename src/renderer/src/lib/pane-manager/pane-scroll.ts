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
    scrollToLineSync(terminal, terminal.buffer.active.baseY)
    return
  }
  const hintRatio = state.totalLines > 0 ? state.viewportY / state.totalLines : undefined
  const target = findLineByContent(terminal, state.firstVisibleLineContent, hintRatio)
  if (target >= 0) {
    let scrollTarget = target
    if (state.logicalLineOffset > 0) {
      const newCols = terminal.cols
      const scaledOffset =
        state.cols > 0 && newCols > 0
          ? Math.round(state.logicalLineOffset * (state.cols / newCols))
          : state.logicalLineOffset
      scrollTarget = Math.min(target + scaledOffset, terminal.buffer.active.baseY)
    }
    console.log(
      '[restoreScrollState] content-match',
      JSON.stringify({
        target,
        scrollTarget,
        logicalLineOffset: state.logicalLineOffset,
        oldCols: state.cols,
        newCols: terminal.cols,
        viewportYBefore: state.viewportY,
        baseY: terminal.buffer.active.baseY,
        contentPrefix: state.firstVisibleLineContent.substring(0, 30)
      })
    )
    scrollToLineSync(terminal, scrollTarget)
    return
  }
  if (hintRatio !== undefined) {
    const newTotalLines = terminal.buffer.active.baseY + terminal.rows
    const fallbackLine = Math.round(hintRatio * newTotalLines)
    const clampedLine = Math.min(fallbackLine, terminal.buffer.active.baseY)
    console.log(
      '[restoreScrollState] proportional-fallback',
      JSON.stringify({
        hintRatio,
        newTotalLines,
        fallbackLine,
        clampedLine,
        baseY: terminal.buffer.active.baseY,
        contentPrefix: state.firstVisibleLineContent.substring(0, 30)
      })
    )
    scrollToLineSync(terminal, clampedLine)
  }
}

// Why: the public terminal.scrollToLine(line) goes through
// CoreBrowserTerminal.scrollLines → viewport.scrollLines, which calls
// SmoothScrollableElement.setScrollPosition WITHOUT updating Viewport's
// _latestYDisp. A subsequent queued _sync (from resize) then sees
// ydisp === _latestYDisp (stale) and skips setScrollPosition, leaving the
// SmoothScrollableElement's internal scrollTop out of sync with the buffer.
// When the user later scrolls (mouse wheel), the SmoothScrollableElement
// adjusts from its stale scrollTop, causing the terminal to jump.
//
// Viewport.scrollToLine(line, disableSmoothScroll=true) directly sets
// _latestYDisp = line before calling setScrollPosition, keeping the
// scrollbar state in sync. We access this through _core._viewport which
// is an internal API (tested against @xterm/xterm 6.0.0). Falls back to
// the public API + scroll jiggle if internals are unavailable.
function scrollToLineSync(terminal: Terminal, line: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewport = (terminal as any)._core?._viewport
  if (viewport && typeof viewport._sync === 'function') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cellH = (terminal as any)._core?._renderService?.dimensions?.css?.cell?.height
      const scrollableEl = viewport._scrollableElement
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bufLines = (terminal as any)._core?._bufferService?.buffer?.lines?.length

      // Why: _sync(line) calls setScrollDimensions (possibly with stale
      // renderer values) then setScrollPosition. If the stale dimensions
      // give a maxScrollTop smaller than our target, the position is
      // silently clamped. We call _sync first to let it do its thing,
      // then OVERRIDE with correct dimensions computed from the actual
      // buffer state, then re-set the scroll position. The second
      // setScrollDimensions + setScrollPosition pair operates against
      // accurate maxScrollTop so the target isn't clamped.
      viewport._latestYDisp = undefined
      viewport._sync(line)

      if (
        cellH &&
        bufLines &&
        scrollableEl?.setScrollDimensions &&
        scrollableEl?.setScrollPosition
      ) {
        // Why: suppress _handleScroll during our dimension fix-up to
        // prevent stale scroll events from overwriting buffer.ydisp.
        viewport._suppressOnScrollHandler = true
        scrollableEl.setScrollDimensions({
          height: cellH * terminal.rows,
          scrollHeight: cellH * bufLines
        })
        viewport._suppressOnScrollHandler = false

        scrollableEl.setScrollPosition({ scrollTop: line * cellH })
      }

      viewport._latestYDisp = line
    } catch {
      terminal.scrollToLine(line)
      forceViewportScrollbarSync(terminal)
    }
    return
  }
  terminal.scrollToLine(line)
  forceViewportScrollbarSync(terminal)
}

// Why: fallback for when the internal viewport API is unavailable. The
// scroll jiggle (-1/+1) triggers _handleScroll with diff≠0, which updates
// _latestYDisp. Less reliable than the direct viewport.scrollToLine path
// because it reads from the SmoothScrollableElement's potentially-stale
// scrollTop, but better than nothing.
function forceViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY > 0) {
    terminal.scrollLines(-1)
    terminal.scrollLines(1)
  } else if (buf.viewportY < buf.baseY) {
    terminal.scrollLines(1)
    terminal.scrollLines(-1)
  }
}
