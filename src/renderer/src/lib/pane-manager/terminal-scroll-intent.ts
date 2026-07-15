import type { IDisposable } from '@xterm/xterm'

type TerminalScrollIntentKind = 'followOutput' | 'pinnedViewport'

type BufferType = 'normal' | 'alternate'

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

type TerminalScrollIntentKey = string

type TerminalScrollIntent = {
  kind: TerminalScrollIntentKind
  bufferType: BufferType
  viewportY: number
  baseY: number
}

type TerminalScrollIntentWriteSnapshot = {
  kind: TerminalScrollIntentKind
  bufferType: BufferType
  viewportY: number
  baseY: number
}

type TerminalScrollIntentEnforceOptions = {
  // 'viewportLine' restores the absolute buffer line (correct while content
  // only grows). 'bottomOffset' restores the distance from the bottom —
  // required after a buffer rebuild (snapshot replay, reflow) renumbers rows.
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
const terminalScrollIntentByKey = new Map<TerminalScrollIntentKey, TerminalScrollIntent>()

const BOTTOM_TOLERANCE_ROWS = 1
const XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES = [
  'xterm-viewport',
  'xterm-scrollbar',
  'xterm-slider'
] as const
const XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR = XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES.map(
  (className) => `.${className}`
).join(',')

function readBufferSnapshot(
  terminal: TerminalScrollIntentTarget
): { bufferType: BufferType; viewportY: number; baseY: number } | null {
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

function writeIntent(
  terminal: TerminalScrollIntentTarget,
  kind: TerminalScrollIntentKind
): TerminalScrollIntent | null {
  const snapshot = readBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  const intent = { kind, ...snapshot }
  terminalScrollIntentByTerminal.set(terminal, intent)
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  if (key) {
    terminalScrollIntentByKey.set(key, intent)
  }
  return intent
}

function readStoredIntent(terminal: TerminalScrollIntentTarget): TerminalScrollIntent | undefined {
  const terminalIntent = terminalScrollIntentByTerminal.get(terminal)
  if (terminalIntent) {
    return terminalIntent
  }
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  return key ? terminalScrollIntentByKey.get(key) : undefined
}

function bindTerminalScrollIntentKey(
  terminal: TerminalScrollIntentTarget,
  key: TerminalScrollIntentKey | undefined
): TerminalScrollIntent | undefined {
  if (!key) {
    return terminalScrollIntentByTerminal.get(terminal)
  }
  terminalScrollIntentKeyByTerminal.set(terminal, key)
  const existing = terminalScrollIntentByKey.get(key)
  if (existing) {
    terminalScrollIntentByTerminal.set(terminal, existing)
  }
  return existing
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
  writeIntent(terminal, 'followOutput')
}

export function markTerminalPinnedViewport(terminal: TerminalScrollIntentTarget): void {
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
    terminalScrollIntentByTerminal.set(terminal, existing)
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
  const sync = (): void => syncTerminalScrollIntentFromViewport(terminal, options)
  queueMicrotask(sync)
  requestAnimationFrame(sync)
  requestAnimationFrame(() => requestAnimationFrame(sync))
  // Why: preservePinnedAtBottom only bridges xterm's async scroll application.
  // The settle tick must reclassify from the real viewport, otherwise a wheel
  // the viewport never followed (sub-row delta, TUI-consumed mouse report,
  // plain PageUp/Home sent to the app) latches a phantom pin at the bottom.
  setTimeout(() => syncTerminalScrollIntentFromViewport(terminal), 80)
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
  let kind =
    existing?.kind ??
    (isAtBottom(snapshot.viewportY, snapshot.baseY) ? 'followOutput' : 'pinnedViewport')
  // Why: a pinned intent whose live viewport still sits at the bottom is a
  // phantom pin (the user's scroll never detached the viewport). Enforcing it
  // would freeze the terminal at the current line on every write batch.
  if (kind === 'pinnedViewport' && isAtBottom(snapshot.viewportY, snapshot.baseY)) {
    kind = 'followOutput'
  }
  return {
    kind,
    bufferType: snapshot.bufferType,
    viewportY: snapshot.viewportY,
    baseY: snapshot.baseY
  }
}

export function enforceTerminalWriteScrollIntent(
  terminal: TerminalScrollIntentTarget,
  snapshot: TerminalScrollIntentWriteSnapshot | null,
  options: TerminalScrollIntentEnforceOptions = {}
): void {
  if (!snapshot) {
    return
  }
  const current = readBufferSnapshot(terminal)
  if (!current || current.bufferType !== snapshot.bufferType) {
    return
  }
  if (snapshot.kind === 'followOutput') {
    if (safeScrollCall(() => terminal.scrollToBottom?.())) {
      writeIntent(terminal, 'followOutput')
    }
    return
  }
  const requestedY =
    options.restoreBy === 'bottomOffset'
      ? current.baseY - Math.max(0, snapshot.baseY - snapshot.viewportY)
      : snapshot.viewportY
  const targetY = clampViewportY(requestedY, current.baseY)
  if (current.viewportY !== targetY) {
    safeScrollCall(() => terminal.scrollToLine?.(targetY))
  }
  writeIntent(terminal, 'pinnedViewport')
}

export function enforceTerminalCurrentScrollIntent(terminal: TerminalScrollIntentTarget): void {
  const existing = readStoredIntent(terminal)
  if (!existing) {
    enforceTerminalWriteScrollIntent(terminal, captureTerminalWriteScrollIntent(terminal))
    return
  }
  const snapshot = {
    kind: existing.kind,
    bufferType: existing.bufferType,
    viewportY: existing.viewportY,
    baseY: existing.baseY
  }
  if (snapshot.kind === 'pinnedViewport' && isAtBottom(snapshot.viewportY, snapshot.baseY)) {
    // Why: a pin recorded at the bottom means the viewport never detached;
    // resuming must follow live output, not freeze at that stale line.
    snapshot.kind = 'followOutput'
  }
  const current = readBufferSnapshot(terminal)
  // Why: a shorter live buffer than the stored intent means the buffer was
  // rebuilt (snapshot replay/remount); absolute lines are renumbered there.
  const restoreBy =
    snapshot.kind === 'pinnedViewport' && current && current.baseY < snapshot.baseY
      ? 'bottomOffset'
      : 'viewportLine'
  enforceTerminalWriteScrollIntent(terminal, snapshot, { restoreBy })
}

export function attachTerminalScrollIntentTracking(
  terminal: TerminalScrollIntentTarget,
  host: HTMLElement,
  intentKey?: TerminalScrollIntentKey
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
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      host.removeEventListener('scroll', onScroll, true)
      globalThis.removeEventListener?.('pointerup', onPointerDone, true)
      globalThis.removeEventListener?.('pointercancel', onPointerDone, true)
    }
  }
}
