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

// Keyed by stable leaf id, so a pin outlives the xterm instance that recorded
// it (workspace switch, keyed remount). Unlike the WeakMap-keyed siblings in
// terminal-scroll-intent.ts these hold a strong string key, so a leaf that is
// gone for good must be released explicitly — see releaseTerminalScrollIntentKey.
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

/**
 * Drops the keyed intent for a leaf that is gone for good. Only safe on a real
 * close: plain disposal (workspace switch, keyed remount, manager destroy)
 * relies on these entries to restore the pin when the leaf mounts again.
 */
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
