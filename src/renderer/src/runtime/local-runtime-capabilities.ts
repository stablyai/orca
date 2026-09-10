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
 *  has landed yet, so a caller that can wait never reads "not asked yet" as "unsupported"
 *  (#19154: that reads a structured-native-chat create as a bare terminal).
 *
 *  The renderer boot chain calls this once, ungated, so the answer is normally already cached
 *  by the time any launch route is resolved — including for the readers that are synchronous
 *  and cannot await. Awaiting it at a route decision is the backstop for the residual window
 *  and for re-probing after a failed one. Still `null` after an actually failed probe, and
 *  never rejects. */
export async function ensureLocalRuntimeCapabilities(): Promise<
  readonly RuntimeCapability[] | null
> {
  if (localRuntimeCapabilities !== null) {
    return localRuntimeCapabilities
  }
  await refreshLocalRuntimeCapabilities()
  return localRuntimeCapabilities
}

/** `refreshLocalRuntimeCapabilities` is not `async`, so a missing or broken preload bridge would
 *  throw synchronously out of it instead of settling into the unknown state its catch owns. */
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
