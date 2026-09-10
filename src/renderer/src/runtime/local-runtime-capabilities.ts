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

/** Like `readLocalRuntimeCapabilitiesOrUnknown`, but probes the local runtime when no answer
 *  has landed yet. Launch-route decisions taken before the hydration-gated refresh runs must
 *  wait for the probe instead of reading "not asked yet" as "unsupported": a pre-hydration
 *  create otherwise silently degrades structured native chat to the legacy route (#19154).
 *  Still `null` after an actually failed probe. */
export async function ensureLocalRuntimeCapabilities(): Promise<
  readonly RuntimeCapability[] | null
> {
  if (localRuntimeCapabilities !== null) {
    return localRuntimeCapabilities
  }
  await refreshLocalRuntimeCapabilities()
  return localRuntimeCapabilities
}

/** Calls the bridge SYNCHRONOUSLY — callers overlap this probe with their own RPC and rely on it
 *  being in flight on return — while turning a broken bridge into a rejection rather than a throw. */
function startLocalRuntimeCapabilityProbe(): ReturnType<typeof window.api.runtime.getStatus> {
  try {
    return window.api.runtime.getStatus()
  } catch (error) {
    return Promise.reject(error)
  }
}

export function refreshLocalRuntimeCapabilities(): Promise<readonly RuntimeCapability[]> {
  refreshPromise ??= startLocalRuntimeCapabilityProbe()
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
  capabilities: readonly RuntimeCapability[] | null
): void {
  localRuntimeCapabilities = capabilities === null ? null : [...capabilities]
  refreshPromise = null
}
