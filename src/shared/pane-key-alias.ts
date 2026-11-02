import { MAX_PANE_KEY_LEN } from './agent-hook-listener/listener-limits'
import { parseLegacyNumericPaneKey, parsePaneKey } from './stable-pane-id'

// Only exact opaque remint tokens ($$<base32>:L$$) may alias physical pane keys; hook ingress expects tabId:leafUuid.
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
