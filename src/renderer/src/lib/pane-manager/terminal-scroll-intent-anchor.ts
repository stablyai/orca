import type { IMarker } from '@xterm/xterm'
import type { TerminalScrollIntent } from './terminal-scroll-intent-key-store'
import { readTerminalScrollBufferSnapshot } from './terminal-scroll-buffer-snapshot'
import {
  captureLogicalLineAnchor,
  resolveLogicalCellOffsetLine,
  type ReflowScrollAnchorTerminal
} from './terminal-reflow-scroll-anchor'

export type TerminalScrollIntentAnchorTarget = {
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
      cursorY?: number
    }
  }
  registerMarker?: (cursorYOffset?: number) => IMarker | undefined
}

type TerminalScrollIntentAnchor = {
  revision: number
  marker: IMarker
  logical?: { marker: IMarker; cellOffset: number }
}

// Why: a pin stores an absolute buffer line, but trimming a full scrollback
// renumbers every line. An xterm marker follows its line through trims, so a
// later restore lands on the content the user was reading.
const anchorByTerminal = new WeakMap<TerminalScrollIntentAnchorTarget, TerminalScrollIntentAnchor>()

function releaseTerminalScrollIntentAnchor(terminal: TerminalScrollIntentAnchorTarget): void {
  const anchor = anchorByTerminal.get(terminal)
  anchor?.marker.dispose()
  anchor?.logical?.marker.dispose()
  anchorByTerminal.delete(terminal)
}

function isReflowScrollAnchorTerminal(
  terminal: TerminalScrollIntentAnchorTarget
): terminal is TerminalScrollIntentAnchorTarget & ReflowScrollAnchorTerminal {
  const active = terminal.buffer?.active
  return (
    'cols' in terminal &&
    typeof terminal.cols === 'number' &&
    active !== undefined &&
    'getLine' in active &&
    typeof active.getLine === 'function' &&
    typeof active.baseY === 'number' &&
    typeof active.cursorY === 'number'
  )
}

function registerLineMarker(
  terminal: TerminalScrollIntentAnchorTarget,
  line: number
): IMarker | undefined {
  const buffer = terminal.buffer?.active
  if (typeof buffer?.baseY !== 'number' || typeof buffer.cursorY !== 'number') {
    return undefined
  }
  let marker: IMarker | undefined
  try {
    marker = terminal.registerMarker?.(line - (buffer.baseY + buffer.cursorY))
  } catch {
    return undefined
  }
  if (marker && !marker.isDisposed && marker.line === line) {
    return marker
  }
  marker?.dispose()
  return undefined
}

// Why: reflow deletes or shifts continuation rows, so a wrapped pin also
// anchors its logical line's first row plus a cell offset (as pane-scroll does).
function anchorLogicalLine(
  terminal: TerminalScrollIntentAnchorTarget,
  viewportY: number
): TerminalScrollIntentAnchor['logical'] {
  if (!isReflowScrollAnchorTerminal(terminal)) {
    return undefined
  }
  const logicalAnchor = captureLogicalLineAnchor(terminal, viewportY)
  if (!logicalAnchor || logicalAnchor.lineY === viewportY) {
    return undefined
  }
  const marker = registerLineMarker(terminal, logicalAnchor.lineY)
  return marker ? { marker, cellOffset: logicalAnchor.cellOffset } : undefined
}

export function anchorPinnedScrollIntent(
  terminal: TerminalScrollIntentAnchorTarget,
  intent: TerminalScrollIntent
): void {
  releaseTerminalScrollIntentAnchor(terminal)
  const buffer = terminal.buffer?.active
  if (
    intent.kind !== 'pinnedViewport' ||
    intent.bufferType !== 'normal' ||
    buffer?.type === 'alternate' ||
    typeof buffer?.baseY !== 'number' ||
    intent.viewportY < 0 ||
    intent.viewportY > buffer.baseY
  ) {
    return
  }
  const marker = registerLineMarker(terminal, intent.viewportY)
  if (marker) {
    anchorByTerminal.set(terminal, {
      revision: intent.revision,
      marker,
      logical: anchorLogicalLine(terminal, intent.viewportY)
    })
  }
}

function resolvePinnedViewportY(
  terminal: TerminalScrollIntentAnchorTarget,
  intent: TerminalScrollIntent
): number | null {
  const anchor = anchorByTerminal.get(terminal)
  if (!anchor || anchor.revision !== intent.revision) {
    return null
  }
  const logical = anchor.logical
  if (
    logical &&
    !logical.marker.isDisposed &&
    logical.marker.line >= 0 &&
    isReflowScrollAnchorTerminal(terminal)
  ) {
    return resolveLogicalCellOffsetLine(terminal, logical.marker.line, logical.cellOffset)
  }
  if (anchor.marker.isDisposed || anchor.marker.line < 0) {
    return null
  }
  return anchor.marker.line
}

type PinnedScrollRestoreSnapshot = { kind: string; viewportY: number; baseY: number }

/** Where enforcing `intent` should restore: live anchor coordinates when a marker survives, else the stored ones. */
export function resolvePinnedScrollRestore<T extends PinnedScrollRestoreSnapshot>(
  terminal: TerminalScrollIntentAnchorTarget,
  intent: TerminalScrollIntent,
  snapshot: T
): { snapshot: T; restoreBy: 'viewportLine' | 'bottomOffset' } {
  const current = readTerminalScrollBufferSnapshot(terminal)
  if (snapshot.kind !== 'pinnedViewport' || !current) {
    return { snapshot, restoreBy: 'viewportLine' }
  }
  const anchoredViewportY = resolvePinnedViewportY(terminal, intent)
  if (anchoredViewportY !== null) {
    // Why: the anchor is in live coordinates; pairing it with the live baseY
    // keeps a trim or reflow from being mistaken for a rebuild.
    return {
      snapshot: { ...snapshot, viewportY: anchoredViewportY, baseY: current.baseY },
      restoreBy: 'viewportLine'
    }
  }
  // Why: a shorter live buffer than the stored intent means the buffer was
  // rebuilt (snapshot replay/remount); absolute lines are renumbered there.
  return { snapshot, restoreBy: current.baseY < snapshot.baseY ? 'bottomOffset' : 'viewportLine' }
}
