import {
  addTerminalFollowOutputWaiter,
  notifyTerminalFollowOutputWaiters
} from './terminal-follow-output-waiters'
import { isTerminalScrollIntentRebuildInFlight } from './terminal-scroll-intent-rebuild'
import {
  anchorPinnedScrollIntent,
  resolvePinnedScrollRestore
} from './terminal-scroll-intent-anchor'
import {
  readKeyedTerminalScrollIntent,
  readKeyedTerminalScrollIntentBinding,
  writeKeyedTerminalScrollIntent,
  writeKeyedTerminalScrollIntentBinding,
  type TerminalScrollIntent,
  type TerminalScrollIntentKey,
  type TerminalScrollIntentKind
} from './terminal-scroll-intent-key-store'
import {
  clampTerminalViewportY,
  isTerminalViewportAtBottom,
  readTerminalScrollBufferSnapshot,
  safeTerminalScrollCall,
  type TerminalScrollBufferType
} from './terminal-scroll-buffer-snapshot'

export type TerminalScrollIntentTarget = {
  buffer?: Parameters<typeof readTerminalScrollBufferSnapshot>[0]['buffer']
  scrollToBottom?: () => void
  scrollToLine?: (line: number) => void
}

export type TerminalStructuralScrollIntentSnapshot = {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
  revision: number
}

type TerminalScrollIntentEnforceOptions = {
  // viewportLine preserves growing-buffer absolute lines; bottomOffset survives renumbering by replay/reflow.
  restoreBy?: 'viewportLine' | 'bottomOffset'
}

const terminalScrollIntentByTerminal = new WeakMap<
  TerminalScrollIntentTarget,
  TerminalScrollIntent
>()
const terminalScrollIntentKeyByTerminal = new WeakMap<
  TerminalScrollIntentTarget,
  TerminalScrollIntentKey
>()
const terminalScrollIntentKeyBindingByTerminal = new WeakMap<TerminalScrollIntentTarget, number>()

let nextTerminalScrollIntentRevision = 1
let nextTerminalScrollIntentKeyBinding = 1

/** Runs `listener` once the terminal's intent next becomes follow-output; returns a canceller. Fires immediately when already following. */
export function onTerminalScrollIntentFollowOutput(
  terminal: TerminalScrollIntentTarget,
  listener: () => void
): () => void {
  if (getTerminalScrollIntentKind(terminal) === 'followOutput') {
    listener()
    return () => {}
  }
  return addTerminalFollowOutputWaiter(terminal, listener)
}

function writeIntent(
  terminal: TerminalScrollIntentTarget,
  kind: TerminalScrollIntentKind
): TerminalScrollIntent | null {
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  return writeIntentSnapshot(terminal, kind, snapshot)
}

function writeIntentSnapshot(
  terminal: TerminalScrollIntentTarget,
  kind: TerminalScrollIntentKind,
  snapshot: { bufferType: TerminalScrollBufferType; viewportY: number; baseY: number }
): TerminalScrollIntent {
  const intent = { kind, ...snapshot, revision: nextTerminalScrollIntentRevision }
  nextTerminalScrollIntentRevision += 1
  terminalScrollIntentByTerminal.set(terminal, intent)
  anchorPinnedScrollIntent(terminal, intent)
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  if (key) {
    writeKeyedTerminalScrollIntent(key, intent)
  }
  if (kind === 'followOutput') {
    notifyTerminalFollowOutputWaiters(terminal)
  }
  return intent
}

function readStoredIntent(terminal: TerminalScrollIntentTarget): TerminalScrollIntent | undefined {
  const terminalIntent = terminalScrollIntentByTerminal.get(terminal)
  if (terminalIntent) {
    return terminalIntent
  }
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  return key ? readKeyedTerminalScrollIntent(key) : undefined
}

export function bindTerminalScrollIntentKey(
  terminal: TerminalScrollIntentTarget,
  key: TerminalScrollIntentKey | undefined
): TerminalScrollIntent | undefined {
  if (!key) {
    return terminalScrollIntentByTerminal.get(terminal)
  }
  terminalScrollIntentKeyByTerminal.set(terminal, key)
  const binding = nextTerminalScrollIntentKeyBinding
  nextTerminalScrollIntentKeyBinding += 1
  terminalScrollIntentKeyBindingByTerminal.set(terminal, binding)
  writeKeyedTerminalScrollIntentBinding(key, binding)
  const existing = readKeyedTerminalScrollIntent(key)
  if (existing) {
    terminalScrollIntentByTerminal.set(terminal, existing)
  }
  return existing
}

export function isTerminalScrollIntentKeyBindingCurrent(
  terminal: TerminalScrollIntentTarget
): boolean {
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  if (!key) {
    return true
  }
  return (
    terminalScrollIntentKeyBindingByTerminal.get(terminal) ===
    readKeyedTerminalScrollIntentBinding(key)
  )
}

export function markTerminalFollowOutput(terminal: TerminalScrollIntentTarget): void {
  writeIntent(terminal, 'followOutput')
}

export function markTerminalPinnedViewport(terminal: TerminalScrollIntentTarget): void {
  writeIntent(terminal, 'pinnedViewport')
}

export function syncTerminalScrollIntentFromViewport(
  terminal: TerminalScrollIntentTarget,
  options: { allowBufferShrink?: boolean; preservePinnedAtBottom?: boolean } = {}
): void {
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    return
  }
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return
  }
  const existing = readStoredIntent(terminal)
  // Transient empty/short scrollback after replay/remount must not erase a durable pin.
  if (
    !options.allowBufferShrink &&
    existing?.kind === 'pinnedViewport' &&
    snapshot.baseY < existing.baseY
  ) {
    terminalScrollIntentByTerminal.set(terminal, existing)
    return
  }
  if (
    options.preservePinnedAtBottom &&
    existing?.kind === 'pinnedViewport' &&
    isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
  ) {
    return
  }
  const kind = isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
    ? 'followOutput'
    : 'pinnedViewport'
  // Parser replies and repeated settle samples can be no-ops; invented revisions cancel valid structural restores and amplify output bursts.
  if (
    existing?.kind === kind &&
    existing.bufferType === snapshot.bufferType &&
    (kind === 'followOutput' ||
      resolvePinnedScrollRestore(terminal, existing).viewportY === snapshot.viewportY)
  ) {
    if (kind === 'pinnedViewport') {
      // Refresh geometry after native baseY growth or trimming without inventing user intent; keyed remount must retain content rather than stale offset.
      Object.assign(existing, snapshot)
    }
    return
  }
  writeIntent(terminal, kind)
}

export function getTerminalScrollIntentKind(
  terminal: TerminalScrollIntentTarget
): TerminalScrollIntentKind {
  const existing = readStoredIntent(terminal)
  if (existing) {
    return existing.kind
  }
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return 'followOutput'
  }
  return isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
    ? 'followOutput'
    : 'pinnedViewport'
}

export function captureTerminalStructuralScrollIntent(
  terminal: TerminalScrollIntentTarget
): TerminalStructuralScrollIntentSnapshot | null {
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    return null
  }
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  const existing = readStoredIntent(terminal)
  let kind =
    existing?.kind ??
    (isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
      ? 'followOutput'
      : 'pinnedViewport')
  // A pin still at bottom is phantom and would freeze stale content; trust that reading only when scrollback is at least as long as the pin, never during shorter replay.
  if (
    kind === 'pinnedViewport' &&
    isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY) &&
    (!existing || snapshot.baseY >= existing.baseY)
  ) {
    kind = 'followOutput'
  }
  // Keyed remount starts 0/0; preserve pre-remount coordinates or bottom-offset restore loses the pin.
  const capturedCoordinates =
    existing?.kind === 'pinnedViewport' && snapshot.baseY < existing.baseY ? existing : snapshot
  return {
    ...capturedCoordinates,
    kind,
    revision: existing?.revision ?? 0
  }
}

export function isTerminalStructuralScrollIntentCurrent(
  terminal: TerminalScrollIntentTarget,
  snapshot: TerminalStructuralScrollIntentSnapshot | null
): boolean {
  if (!snapshot) {
    return false
  }
  return (readStoredIntent(terminal)?.revision ?? 0) === snapshot.revision
}

export function restoreTerminalStructuralScrollIntent(
  terminal: TerminalScrollIntentTarget,
  snapshot: TerminalStructuralScrollIntentSnapshot | null,
  options: TerminalScrollIntentEnforceOptions = {}
): void {
  if (
    !snapshot ||
    !isTerminalStructuralScrollIntentCurrent(terminal, snapshot) ||
    isTerminalScrollIntentRebuildInFlight(terminal)
  ) {
    return
  }
  const current = readTerminalScrollBufferSnapshot(terminal)
  if (!current || current.bufferType !== snapshot.bufferType) {
    return
  }
  if (snapshot.kind === 'followOutput') {
    if (safeTerminalScrollCall(() => terminal.scrollToBottom?.())) {
      writeIntent(terminal, 'followOutput')
    }
    return
  }
  const requestedY =
    options.restoreBy === 'bottomOffset'
      ? current.baseY - Math.max(0, snapshot.baseY - snapshot.viewportY)
      : snapshot.viewportY
  const targetY = clampTerminalViewportY(requestedY, current.baseY)
  if (current.viewportY !== targetY) {
    if (!safeTerminalScrollCall(() => terminal.scrollToLine?.(targetY))) {
      // Renderer teardown can reject scrolling; retain the intended pin for retry instead of latching transient bottom geometry.
      writeIntentSnapshot(terminal, 'pinnedViewport', {
        bufferType: current.bufferType,
        viewportY: targetY,
        baseY: current.baseY
      })
      return
    }
  }
  const existing = readStoredIntent(terminal)
  // Shorter scrollback indicates rebuild; relatching would overwrite the durable pin with cleared line zero.
  if (existing?.kind === 'pinnedViewport' && current.baseY < existing.baseY) {
    return
  }
  writeIntent(terminal, 'pinnedViewport')
}

export function enforceTerminalCurrentScrollIntent(terminal: TerminalScrollIntentTarget): void {
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    return
  }
  const existing = readStoredIntent(terminal)
  if (!existing) {
    restoreTerminalStructuralScrollIntent(terminal, captureTerminalStructuralScrollIntent(terminal))
    return
  }
  const snapshot = {
    kind: existing.kind,
    bufferType: existing.bufferType,
    viewportY: existing.viewportY,
    baseY: existing.baseY,
    revision: existing.revision
  }
  if (
    snapshot.kind === 'pinnedViewport' &&
    isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
  ) {
    // A pin recorded at bottom never detached; resume must follow output instead of freezing that stale line.
    snapshot.kind = 'followOutput'
  }
  const restore = resolvePinnedScrollRestore(terminal, existing)
  snapshot.viewportY = restore.viewportY
  restoreTerminalStructuralScrollIntent(terminal, snapshot, { restoreBy: restore.restoreBy })
}
