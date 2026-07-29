/**
 * Renderer-side predicate for main's Phase-4 hidden PTY delivery gate.
 *
 * The gate only operates when main holds side-effect authority for the PTY
 * (see isMainTerminalSideEffectAuthorityForPty) AND the gate-specific kill
 * switch is on. Callers decide once at pane/watcher creation — the decision
 * picks which mode-2031 responder is registered (byte sidecar vs fact reply),
 * so it must never flip per chunk.
 */
import type { GlobalSettings } from '../../../../shared/types'

// Why: cached once per session — the blocking read should only ever run on
// the pre-hydration startup path, never per pane bind.
let persistedGateFlagCache: boolean | null | undefined

function readPersistedHiddenDeliveryGateFlagSync(): boolean | null {
  if (persistedGateFlagCache === undefined) {
    try {
      const getSync = (globalThis as { window?: Window }).window?.api?.settings?.getSync
      persistedGateFlagCache =
        typeof getSync === 'function' ? (getSync()?.terminalHiddenDeliveryGate ?? null) : null
    } catch {
      persistedGateFlagCache = null
    }
  }
  return persistedGateFlagCache
}

export function isRendererHiddenPtyDeliveryGateEnabled(
  settings: Pick<GlobalSettings, 'terminalHiddenDeliveryGate'> | null
): boolean {
  if (settings !== null) {
    return settings.terminalHiddenDeliveryGate !== false
  }
  // Why: settings hydrate asynchronously; a pane/watcher bound before
  // hydration must honor the persisted kill switch — the responder-mode
  // decision made here is never revisited (same rationale as the
  // side-effect-authority sync read).
  return readPersistedHiddenDeliveryGateFlagSync() !== false
}

/** Test seam: reset the persisted-flag cache between tests. */
export function _resetHiddenPtyDeliveryGateFlagCacheForTest(): void {
  persistedGateFlagCache = undefined
}
