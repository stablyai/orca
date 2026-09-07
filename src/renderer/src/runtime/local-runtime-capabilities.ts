import type { RuntimeCapability } from '../../../shared/protocol-version'

// `null` while no successful probe has landed. "Not asked yet" and "host says no" are
// different answers, and a caller that routes on them must be able to tell them apart.
let localRuntimeCapabilities: readonly RuntimeCapability[] | null = null
let refreshPromise: Promise<readonly RuntimeCapability[]> | null = null

export function readLocalRuntimeCapabilities(): readonly RuntimeCapability[] {
  return localRuntimeCapabilities ?? []
}

/** `null` when the local runtime has not answered yet, so a routing decision can wait
 *  instead of reading an unprobed host as unsupported. */
export function readLocalRuntimeCapabilitiesOrUnknown(): readonly RuntimeCapability[] | null {
  return localRuntimeCapabilities
}

export function refreshLocalRuntimeCapabilities(): Promise<readonly RuntimeCapability[]> {
  refreshPromise ??= window.api.runtime
    .getStatus()
    .then((status) => {
      localRuntimeCapabilities = [...(status.capabilities ?? [])]
      return localRuntimeCapabilities
    })
    .catch(() => {
      // Stays unknown rather than becoming an empty (== unsupported) list: a failed probe
      // is not evidence about the host.
      localRuntimeCapabilities = null
      return []
    })
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

export function setLocalRuntimeCapabilitiesForTests(
  capabilities: readonly RuntimeCapability[]
): void {
  localRuntimeCapabilities = [...capabilities]
  refreshPromise = null
}
