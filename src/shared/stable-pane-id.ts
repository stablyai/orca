// Why: paneKey crosses renderer reloads, PTY env, hook IPC, and retained UI
// rows, so it must use the durable terminal-layout leaf UUID instead of the
// renderer-local numeric PaneManager id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

declare const stablePaneIdBrand: unique symbol
declare const terminalLeafIdBrand: unique symbol
declare const paneKeyBrand: unique symbol

export type StablePaneId = string & { readonly [stablePaneIdBrand]: true }
export type TerminalLeafId = StablePaneId & { readonly [terminalLeafIdBrand]: true }
export type PaneKey = string & { readonly [paneKeyBrand]: true }

export function isStablePaneId(value: string): value is StablePaneId {
  return UUID_RE.test(value)
}

export function isTerminalLeafId(value: string): value is TerminalLeafId {
  return isStablePaneId(value)
}

export function makePaneKey(tabId: string, stableLeafId: string): PaneKey {
  if (!tabId || tabId.includes(':')) {
    throw new Error('tabId must be non-empty and must not contain ":"')
  }
  if (!isTerminalLeafId(stableLeafId)) {
    throw new Error('stableLeafId must be a UUID')
  }
  return `${tabId}:${stableLeafId}` as PaneKey
}

export function parsePaneKey(
  paneKey: string
): { tabId: string; leafId: TerminalLeafId; stablePaneId: StablePaneId } | null {
  const first = paneKey.indexOf(':')
  if (first <= 0 || first !== paneKey.lastIndexOf(':') || first === paneKey.length - 1) {
    return null
  }
  const tabId = paneKey.slice(0, first)
  const leafId = paneKey.slice(first + 1)
  if (!isTerminalLeafId(leafId)) {
    return null
  }
  return { tabId, leafId, stablePaneId: leafId }
}

export function parseLegacyNumericPaneKey(
  paneKey: unknown
): { tabId: string; numericPaneId: string; paneKey: string } | null {
  if (typeof paneKey !== 'string' || paneKey.length > 256) {
    return null
  }
  const trimmed = paneKey.trim()
  const delimiter = trimmed.indexOf(':')
  if (
    delimiter <= 0 ||
    delimiter !== trimmed.lastIndexOf(':') ||
    delimiter === trimmed.length - 1
  ) {
    return null
  }
  const numericPaneId = trimmed.slice(delimiter + 1)
  if (!/^\d+$/.test(numericPaneId)) {
    return null
  }
  return { tabId: trimmed.slice(0, delimiter), numericPaneId, paneKey: trimmed }
}
