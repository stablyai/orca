import type { TerminalScrollBufferType } from './terminal-scroll-buffer-snapshot'

export type TerminalScrollIntentKind = 'followOutput' | 'pinnedViewport'
export type TerminalScrollIntentKey = string

export type TerminalScrollIntent = {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
  revision: number
}

// Stable leaf pins survive remount, unlike terminal WeakMaps. Strong string keys require explicit release only when the leaf is gone permanently.
const terminalScrollIntentByKey = new Map<TerminalScrollIntentKey, TerminalScrollIntent>()
const terminalScrollIntentBindingByKey = new Map<TerminalScrollIntentKey, number>()

export function readKeyedTerminalScrollIntent(
  key: TerminalScrollIntentKey
): TerminalScrollIntent | undefined {
  return terminalScrollIntentByKey.get(key)
}

export function writeKeyedTerminalScrollIntent(
  key: TerminalScrollIntentKey,
  intent: TerminalScrollIntent
): void {
  terminalScrollIntentByKey.set(key, intent)
}

export function readKeyedTerminalScrollIntentBinding(
  key: TerminalScrollIntentKey
): number | undefined {
  return terminalScrollIntentBindingByKey.get(key)
}

export function writeKeyedTerminalScrollIntentBinding(
  key: TerminalScrollIntentKey,
  binding: number
): void {
  terminalScrollIntentBindingByKey.set(key, binding)
}

/** Release only on real close; workspace switch/remount/manager disposal needs the keyed pin for restoration. */
export function releaseTerminalScrollIntentKey(key: TerminalScrollIntentKey): void {
  terminalScrollIntentByKey.delete(key)
  terminalScrollIntentBindingByKey.delete(key)
}

/** Retention probe for the leak tests. */
export function readTerminalScrollIntentKeyRetention(): { intents: number; bindings: number } {
  return {
    intents: terminalScrollIntentByKey.size,
    bindings: terminalScrollIntentBindingByKey.size
  }
}
