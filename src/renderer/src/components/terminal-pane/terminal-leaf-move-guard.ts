// Keys of moves whose main commit or apply is still running; a second move on the same key is a no-op.
const heldKeys = new Set<string>()

/** Takes every key at once, or none: null when any is already held. The caller releases when done. */
export function holdTerminalMoveKeys(keys: readonly string[]): (() => void) | null {
  if (keys.some((key) => heldKeys.has(key))) {
    return null
  }
  keys.forEach((key) => heldKeys.add(key))
  return () => keys.forEach((key) => heldKeys.delete(key))
}

export function terminalLeafMoveKey(leafId: string): string {
  return `leaf:${leafId}`
}

export function terminalTabMoveKey(tabId: string): string {
  return `tab:${tabId}`
}

export function isTerminalTabMoveInFlight(tabId: string): boolean {
  return heldKeys.has(terminalTabMoveKey(tabId))
}

export function isTerminalLeafMoveInFlight(leafId: string): boolean {
  return heldKeys.has(terminalLeafMoveKey(leafId))
}
