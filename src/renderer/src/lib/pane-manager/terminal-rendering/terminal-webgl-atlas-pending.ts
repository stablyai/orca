import type { AtlasIntegrityState } from './terminal-webgl-atlas-integrity'
import type { GlyphAtlasLike } from './terminal-webgl-atlas-sampling'

const PENDING_EXPIRY_MS = 30_000

/** Drops collected, expired and directly served entries in one bounded pass. */
export function maintainAtlasPending(
  state: AtlasIntegrityState,
  now: number,
  servedAtlas?: GlyphAtlasLike
): void {
  for (const [ref, queuedAt] of state.pending) {
    const atlas = ref.deref()
    if (!atlas || atlas === servedAtlas || now - queuedAt > PENDING_EXPIRY_MS) {
      state.pending.delete(ref)
    }
  }
  if (servedAtlas && state.pending.size === 0) {
    state.serviceTimer?.cancel()
    state.serviceTimer = null
  }
}
