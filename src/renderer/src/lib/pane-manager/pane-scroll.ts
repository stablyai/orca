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
  const bufferType = buf.type
  const viewportY = buf.viewportY
  const wasAtBottom = viewportY >= buf.baseY
  const firstVisibleLineContent = buf.getLine(viewportY)?.translateToString(true)?.trimEnd() ?? ''
  const totalLines = buf.baseY + terminal.rows
  return { bufferType, wasAtBottom, firstVisibleLineContent, viewportY, totalLines }
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
    terminal.scrollToLine(target)
    forceViewportScrollbarSync(terminal)
  }
}

// Why: xterm 6's Viewport._sync() updates scrollDimensions after resize but
// skips the scrollPosition update when ydisp matches _latestYDisp (a stale
// internal value). This leaves the scrollbar thumb at a wrong position even
// though the rendered content is correct. A scroll jiggle (-1/+1) in the
// same JS turn forces _sync() to fire with a differing ydisp, which triggers
// setScrollPosition and syncs the scrollbar. No paint occurs between the two
// synchronous calls so the intermediate state is never visible.
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
