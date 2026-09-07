import { MAX_PANE_KEY_LEN } from './agent-hook-listener/listener-limits'
import { parseLegacyNumericPaneKey, parsePaneKey } from './stable-pane-id'

// Why: remint mints an opaque `$$<base32>:L$$` token (same secret-class wrapping as
// launch tokens). The hook pipeline only accepts `${tabId}:${leafUuid}`, so this
// exact form is the physical key we may alias — never an arbitrary string.
const OPAQUE_REMINTED_PANE_KEY_RE = /^\$\$[A-Za-z2-7]{8,64}:L\$\$$/

export function isOpaqueRemintedPaneKey(value: string): boolean {
  return value.length <= MAX_PANE_KEY_LEN && OPAQUE_REMINTED_PANE_KEY_RE.test(value)
}

export function canRegisterPaneKeyAlias(fromPaneKey: string, toPaneKey: string): boolean {
  if (
    fromPaneKey.length === 0 ||
    fromPaneKey.length > MAX_PANE_KEY_LEN ||
    toPaneKey.length === 0 ||
    toPaneKey.length > MAX_PANE_KEY_LEN
  ) {
    return false
  }
  const stable = parsePaneKey(toPaneKey)
  if (!stable) {
    return false
  }
  const legacy = parseLegacyNumericPaneKey(fromPaneKey)
  if (legacy) {
    return legacy.tabId === stable.tabId
  }
  return isOpaqueRemintedPaneKey(fromPaneKey)
}
