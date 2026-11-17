import {
  INITIAL_SETUP_SCRIPT_PROBE_STATE,
  type SetupScriptProbeState
} from './setup-guide-progress-readiness'

// Share bounded probe results across mounted checklist consumers.
const setupScriptProbeCacheListeners = new Set<() => void>()
let setupScriptProbeCache = INITIAL_SETUP_SCRIPT_PROBE_STATE

export function readSetupScriptProbeCache(): SetupScriptProbeState {
  return setupScriptProbeCache
}

export function subscribeSetupScriptProbeCache(listener: () => void): () => void {
  setupScriptProbeCacheListeners.add(listener)
  return () => {
    setupScriptProbeCacheListeners.delete(listener)
  }
}

export function setSetupScriptProbeCache(next: SetupScriptProbeState): void {
  if (
    setupScriptProbeCache.signature === next.signature &&
    setupScriptProbeCache.ready === next.ready &&
    setupScriptProbeCache.hasSetupScript === next.hasSetupScript
  ) {
    return
  }
  setupScriptProbeCache = next
  for (const listener of setupScriptProbeCacheListeners) {
    listener()
  }
}
