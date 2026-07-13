export type TerminalScrollIntentKind = 'followOutput' | 'pinnedViewport'
export type TerminalScrollBufferType = 'normal' | 'alternate'

export type TerminalScrollIntentState = {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
  revision: number
}

type TerminalScrollIntentKey = string
type TerminalScrollIntentTarget = object

const intentByTerminal = new WeakMap<TerminalScrollIntentTarget, TerminalScrollIntentState>()
const keyByTerminal = new WeakMap<TerminalScrollIntentTarget, TerminalScrollIntentKey>()
const intentByKey = new Map<TerminalScrollIntentKey, TerminalScrollIntentState>()

export function storeTerminalScrollIntentState(
  terminal: TerminalScrollIntentTarget,
  intent: TerminalScrollIntentState
): void {
  intentByTerminal.set(terminal, intent)
  const key = keyByTerminal.get(terminal)
  if (key) {
    intentByKey.set(key, intent)
  }
}

export function readTerminalScrollIntentState(
  terminal: TerminalScrollIntentTarget
): TerminalScrollIntentState | undefined {
  const terminalIntent = intentByTerminal.get(terminal)
  const key = keyByTerminal.get(terminal)
  const keyedIntent = key ? intentByKey.get(key) : undefined
  return !terminalIntent || (keyedIntent && keyedIntent.revision > terminalIntent.revision)
    ? keyedIntent
    : terminalIntent
}

export function bindTerminalScrollIntentStateKey(
  terminal: TerminalScrollIntentTarget,
  key: TerminalScrollIntentKey | undefined
): TerminalScrollIntentState | undefined {
  if (!key) {
    return intentByTerminal.get(terminal)
  }
  keyByTerminal.set(terminal, key)
  const existing = intentByKey.get(key)
  if (existing) {
    intentByTerminal.set(terminal, existing)
  }
  return existing
}

export function unbindTerminalScrollIntentStateKey(terminal: TerminalScrollIntentTarget): void {
  keyByTerminal.delete(terminal)
}

export function forgetTerminalScrollIntentStateByKey(intentKey: TerminalScrollIntentKey): void {
  intentByKey.delete(intentKey)
}

export function forgetTerminalScrollIntentStatesByKey(
  intentKeys: Iterable<TerminalScrollIntentKey>
): void {
  for (const intentKey of intentKeys) {
    intentByKey.delete(intentKey)
  }
}

export function getTerminalScrollIntentKindByKey(
  intentKey: TerminalScrollIntentKey
): TerminalScrollIntentKind {
  return intentByKey.get(intentKey)?.kind ?? 'followOutput'
}

export function setTerminalScrollIntentKindByKey(
  intentKey: TerminalScrollIntentKey,
  kind: TerminalScrollIntentKind
): void {
  const existing = intentByKey.get(intentKey)
  // Why: cold panes have no xterm buffer to sample but still need a durable
  // directive that their first mounted instance can consume.
  intentByKey.set(
    intentKey,
    existing
      ? { ...existing, kind, revision: existing.revision + 1 }
      : { kind, bufferType: 'normal', viewportY: 0, baseY: 0, revision: 1 }
  )
}
