import type { IMarker } from '@xterm/xterm'
import type { TerminalScrollIntent } from './terminal-scroll-intent-key-store'
import {
  isTerminalViewportAtBottom,
  readTerminalScrollBufferSnapshot
} from './terminal-scroll-buffer-snapshot'

type TerminalScrollIntentAnchorTarget = {
  buffer?: { active?: { type?: string; viewportY?: number; baseY?: number; cursorY?: number } }
  registerMarker?: (cursorYOffset?: number) => IMarker | undefined
}

// Why: trimming a full scrollback renumbers the absolute line a pin stores; an
// xterm marker follows that line's content instead.
const anchorByTerminal = new WeakMap<
  TerminalScrollIntentAnchorTarget,
  { revision: number; marker: IMarker }
>()

export function anchorPinnedScrollIntent(
  terminal: TerminalScrollIntentAnchorTarget,
  intent: TerminalScrollIntent
): void {
  anchorByTerminal.get(terminal)?.marker.dispose()
  anchorByTerminal.delete(terminal)
  const cursorY = terminal.buffer?.active?.cursorY
  if (
    intent.kind !== 'pinnedViewport' ||
    intent.bufferType !== 'normal' ||
    typeof cursorY !== 'number' ||
    isTerminalViewportAtBottom(intent.viewportY, intent.baseY)
  ) {
    return
  }
  const marker = terminal.registerMarker?.(intent.viewportY - (intent.baseY + cursorY))
  if (marker) {
    anchorByTerminal.set(terminal, { revision: intent.revision, marker })
  }
}

/** Pinned restore target: the anchored live line, else the stored coordinates (followOutput ignores both). */
export function resolvePinnedScrollRestore(
  terminal: TerminalScrollIntentAnchorTarget,
  intent: TerminalScrollIntent
): { viewportY: number; restoreBy: 'viewportLine' | 'bottomOffset' } {
  const anchor = anchorByTerminal.get(terminal)
  if (anchor && anchor.revision === intent.revision && !anchor.marker.isDisposed) {
    return { viewportY: anchor.marker.line, restoreBy: 'viewportLine' }
  }
  const current = readTerminalScrollBufferSnapshot(terminal)
  // Rebuilt/remounted buffers renumber absolute lines; use offset when live scrollback is shorter than the stored intent.
  const restoreBy = current && current.baseY < intent.baseY ? 'bottomOffset' : 'viewportLine'
  return { viewportY: intent.viewportY, restoreBy }
}
