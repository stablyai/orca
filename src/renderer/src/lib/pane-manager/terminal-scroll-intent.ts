import type { IDisposable } from '@xterm/xterm'
import {
  bindTerminalScrollIntentStateKey as bindTerminalScrollIntentKey,
  readTerminalScrollIntentState as readStoredIntent,
  storeTerminalScrollIntentState,
  unbindTerminalScrollIntentStateKey,
  type TerminalScrollBufferType,
  type TerminalScrollIntentKind,
  type TerminalScrollIntentState
} from './terminal-scroll-intent-state'

export {
  forgetTerminalScrollIntentStateByKey,
  forgetTerminalScrollIntentStatesByKey,
  getTerminalScrollIntentKindByKey,
  setTerminalScrollIntentKindByKey,
  type TerminalScrollIntentKind
} from './terminal-scroll-intent-state'

type TerminalScrollIntentTarget = {
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
    }
  }
  scrollToBottom?: () => void
  scrollToLine?: (line: number) => void
}

type TerminalScrollIntentWriteSnapshot = {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  revision: number
}

const BOTTOM_TOLERANCE_ROWS = 1
const XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES = [
  'xterm-viewport',
  'xterm-scrollbar',
  'xterm-slider'
] as const
const XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR = XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES.map(
  (className) => `.${className}`
).join(',')
const viewportSyncBatchByTerminal = new WeakMap<TerminalScrollIntentTarget, object>()

function readBufferSnapshot(
  terminal: TerminalScrollIntentTarget
): { bufferType: TerminalScrollBufferType; viewportY: number; baseY: number } | null {
  const buffer = terminal.buffer?.active
  const viewportY = buffer?.viewportY
  const baseY = buffer?.baseY
  if (typeof viewportY !== 'number' || typeof baseY !== 'number') {
    return null
  }
  return {
    bufferType: buffer?.type === 'alternate' ? 'alternate' : 'normal',
    viewportY,
    baseY
  }
}

function isAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY - BOTTOM_TOLERANCE_ROWS
}

export function isTerminalViewportAtBottom(terminal: TerminalScrollIntentTarget): boolean {
  const snapshot = readBufferSnapshot(terminal)
  return snapshot ? isAtBottom(snapshot.viewportY, snapshot.baseY) : true
}

function writeIntent(
  terminal: TerminalScrollIntentTarget,
  kind: TerminalScrollIntentKind,
  options: { revision?: number } = {}
): TerminalScrollIntentState | null {
  const snapshot = readBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  const revision = options.revision ?? (readStoredIntent(terminal)?.revision ?? 0) + 1
  const intent = { kind, ...snapshot, revision }
  storeTerminalScrollIntentState(terminal, intent)
  return intent
}

function clampViewportY(viewportY: number, baseY: number): number {
  return Math.max(0, Math.min(viewportY, baseY))
}

function safeScrollCall(fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (err) {
    if (err instanceof TypeError && /dimensions/.test(err.message)) {
      return false
    }
    throw err
  }
}

function isTerminalScrollIntentPointerTarget(target: EventTarget | null): target is Element {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false
  }
  // xterm's custom scrollbar uses separate thumb/track nodes from the viewport.
  return target.closest(XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR) !== null
}

export function markTerminalFollowOutput(terminal: TerminalScrollIntentTarget): void {
  viewportSyncBatchByTerminal.delete(terminal)
  writeIntent(terminal, 'followOutput')
}

export function markTerminalPinnedViewport(terminal: TerminalScrollIntentTarget): void {
  viewportSyncBatchByTerminal.delete(terminal)
  writeIntent(terminal, 'pinnedViewport')
}

export function syncTerminalScrollIntentFromViewport(
  terminal: TerminalScrollIntentTarget,
  options: { preservePinnedAtBottom?: boolean } = {}
): void {
  const snapshot = readBufferSnapshot(terminal)
  if (!snapshot) {
    return
  }
  const existing = readStoredIntent(terminal)
  // Why: a remounted/replayed terminal can briefly report an empty or shorter
  // scrollback. That transient state must not erase a durable pinned viewport.
  if (existing?.kind === 'pinnedViewport' && snapshot.baseY < existing.baseY) {
    storeTerminalScrollIntentState(terminal, existing)
    return
  }
  if (
    options.preservePinnedAtBottom &&
    existing?.kind === 'pinnedViewport' &&
    isAtBottom(snapshot.viewportY, snapshot.baseY)
  ) {
    return
  }
  writeIntent(
    terminal,
    isAtBottom(snapshot.viewportY, snapshot.baseY) ? 'followOutput' : 'pinnedViewport'
  )
}

export function syncTerminalScrollIntentSoon(
  terminal: TerminalScrollIntentTarget,
  options: { preservePinnedAtBottom?: boolean } = {}
): void {
  const batch = {}
  viewportSyncBatchByTerminal.set(terminal, batch)
  let expectedRevision = readStoredIntent(terminal)?.revision ?? 0
  const sync = (): void => {
    if (viewportSyncBatchByTerminal.get(terminal) !== batch) {
      return
    }
    if ((readStoredIntent(terminal)?.revision ?? 0) !== expectedRevision) {
      return
    }
    syncTerminalScrollIntentFromViewport(terminal, options)
    // Why: allow this settling batch to sample later frames, but invalidate it
    // when an explicit auto-scroll command advances the revision in between.
    expectedRevision = readStoredIntent(terminal)?.revision ?? expectedRevision
  }
  queueMicrotask(sync)
  requestAnimationFrame(sync)
  requestAnimationFrame(() => requestAnimationFrame(sync))
  setTimeout(sync, 80)
}

export function getTerminalScrollIntentKind(
  terminal: TerminalScrollIntentTarget
): TerminalScrollIntentKind {
  const existing = readStoredIntent(terminal)
  if (existing) {
    return existing.kind
  }
  const snapshot = readBufferSnapshot(terminal)
  if (!snapshot) {
    return 'followOutput'
  }
  return isAtBottom(snapshot.viewportY, snapshot.baseY) ? 'followOutput' : 'pinnedViewport'
}

export function captureTerminalWriteScrollIntent(
  terminal: TerminalScrollIntentTarget
): TerminalScrollIntentWriteSnapshot | null {
  const snapshot = readBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  const existing = readStoredIntent(terminal)
  const kind =
    existing?.kind ??
    (isAtBottom(snapshot.viewportY, snapshot.baseY) ? 'followOutput' : 'pinnedViewport')
  return {
    kind,
    bufferType: snapshot.bufferType,
    viewportY: snapshot.viewportY,
    revision: existing?.revision ?? 0
  }
}

export function enforceTerminalWriteScrollIntent(
  terminal: TerminalScrollIntentTarget,
  snapshot: TerminalScrollIntentWriteSnapshot | null
): void {
  if (!snapshot) {
    return
  }
  const stored = readStoredIntent(terminal)
  const effectiveSnapshot =
    (stored?.revision ?? 0) === snapshot.revision
      ? snapshot
      : stored
        ? {
            kind: stored.kind,
            bufferType: stored.bufferType,
            viewportY: stored.viewportY,
            revision: stored.revision
          }
        : null
  // Why: auto-scroll can be toggled while xterm parses a write. Enforce the
  // latest intent so neither an old pin nor an old follow callback wins.
  if (!effectiveSnapshot) {
    return
  }
  const current = readBufferSnapshot(terminal)
  if (!current || current.bufferType !== effectiveSnapshot.bufferType) {
    return
  }
  if (effectiveSnapshot.kind === 'followOutput') {
    if (safeScrollCall(() => terminal.scrollToBottom?.())) {
      writeIntent(terminal, 'followOutput', { revision: effectiveSnapshot.revision })
    }
    return
  }
  const targetY = clampViewportY(effectiveSnapshot.viewportY, current.baseY)
  if (current.viewportY !== targetY && !safeScrollCall(() => terminal.scrollToLine?.(targetY))) {
    // Why: SSH/WebGL reattach can expose the buffer before render dimensions.
    // Keep the durable viewport so the next visibility pass can retry it.
    return
  }
  writeIntent(terminal, 'pinnedViewport', { revision: effectiveSnapshot.revision })
}

export function enforceTerminalCurrentScrollIntent(terminal: TerminalScrollIntentTarget): void {
  const existing = readStoredIntent(terminal)
  const snapshot = existing
    ? {
        kind: existing.kind,
        bufferType: existing.bufferType,
        viewportY: existing.viewportY,
        revision: existing.revision
      }
    : captureTerminalWriteScrollIntent(terminal)
  enforceTerminalWriteScrollIntent(terminal, snapshot)
}

export function attachTerminalScrollIntentTracking(
  terminal: TerminalScrollIntentTarget,
  host: HTMLElement,
  intentKey?: string
): IDisposable {
  if (!bindTerminalScrollIntentKey(terminal, intentKey)) {
    syncTerminalScrollIntentFromViewport(terminal)
  }
  let pointerScrollActive = false

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) {
      markTerminalPinnedViewport(terminal)
      syncTerminalScrollIntentSoon(terminal, { preservePinnedAtBottom: true })
      return
    }
    syncTerminalScrollIntentSoon(terminal)
  }

  const onPointerDown = (event: PointerEvent): void => {
    pointerScrollActive = isTerminalScrollIntentPointerTarget(event.target)
  }

  const onPointerDone = (): void => {
    if (!pointerScrollActive) {
      return
    }
    pointerScrollActive = false
    syncTerminalScrollIntentFromViewport(terminal)
  }

  const onScroll = (): void => {
    if (pointerScrollActive) {
      syncTerminalScrollIntentFromViewport(terminal)
    }
  }

  host.addEventListener('wheel', onWheel, { capture: true, passive: true })
  host.addEventListener('pointerdown', onPointerDown, true)
  host.addEventListener('scroll', onScroll, true)
  globalThis.addEventListener?.('pointerup', onPointerDone, true)
  globalThis.addEventListener?.('pointercancel', onPointerDone, true)
  return {
    dispose: () => {
      viewportSyncBatchByTerminal.delete(terminal)
      unbindTerminalScrollIntentStateKey(terminal)
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      host.removeEventListener('scroll', onScroll, true)
      globalThis.removeEventListener?.('pointerup', onPointerDone, true)
      globalThis.removeEventListener?.('pointercancel', onPointerDone, true)
    }
  }
}
