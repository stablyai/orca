import type { Terminal } from '@xterm/xterm'

type LinkifierHoverCache = {
  _lastBufferCell?: unknown
  _activeLine?: number
}

type TerminalCoreWithLinkifier = {
  _core?: {
    linkifier?: LinkifierHoverCache
  }
}

/**
 * Force xterm's linkifier to re-run link providers on the next mousemove.
 *
 * Why: when a terminal is hidden (worktree/tab switch) the browser fires
 * `mouseleave`, which clears the linkifier's current link but leaves its
 * `_lastBufferCell` cache set. On reveal the pointer usually returns to the
 * same cell, so xterm's mousemove handler short-circuits (position unchanged)
 * and never re-linkifies — the link (file path, URL, term_* handle, OSC-8)
 * stays dead until a scroll shifts the buffer position. Clearing the cell/line
 * cache makes the next mousemove re-evaluate providers so the link and its
 * hover underline recover without a scroll.
 *
 * Reaches into xterm internals (`@xterm/xterm` 6.1.0-beta.287 `Linkifier`)
 * because there is no public API to invalidate the hover cache. Guarded so a
 * future xterm build that renames these fields degrades to the pre-fix
 * behavior (link recovers on the next genuine cell change) instead of throwing.
 */
export function resetTerminalLinkifierHoverState(terminal: Terminal): void {
  try {
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    if (!linkifier) {
      return
    }
    if ('_lastBufferCell' in linkifier) {
      linkifier._lastBufferCell = undefined
    }
    if ('_activeLine' in linkifier) {
      linkifier._activeLine = -1
    }
  } catch {
    /* linkifier internals unavailable — link recovers on the next cell change */
  }
}
