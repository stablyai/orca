import type { RuntimeCapability } from '../../../shared/protocol-version'

type LocalRuntimeCapabilityObservation =
  | { state: 'unlearned' | 'pending' | 'unavailable' }
  | { state: 'known'; capabilities: readonly RuntimeCapability[] }
let observation: LocalRuntimeCapabilityObservation = { state: 'unlearned' }
let refreshPromise: Promise<readonly RuntimeCapability[]> | null = null
const knownListeners = new Set<(capabilities: readonly RuntimeCapability[]) => void>()
const listeners = new Set<() => void>()

export function readLocalRuntimeCapabilityObservation(): LocalRuntimeCapabilityObservation {
  return observation
}

export function subscribeLocalRuntimeCapabilityObservation(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: LocalRuntimeCapabilityObservation): void {
  observation = next
  listeners.forEach((listener) => listener())
}

/** Called each time a probe lands an answer, so work that needs the capabilities runs when they
 *  become known instead of being skipped while they were not. Returns the unsubscribe. */
export function subscribeLocalRuntimeCapabilitiesKnown(
  listener: (capabilities: readonly RuntimeCapability[]) => void
): () => void {
  knownListeners.add(listener)
  return () => {
    knownListeners.delete(listener)
  }
}

export function readLocalRuntimeCapabilities(): readonly RuntimeCapability[] {
  return readLocalRuntimeCapabilitiesOrUnknown() ?? []
}

/** `null` when the local runtime has not answered yet, so a routing decision can wait
 *  instead of reading an unprobed host as unsupported. */
export function readLocalRuntimeCapabilitiesOrUnknown(): readonly RuntimeCapability[] | null {
  return observation.state === 'known' ? observation.capabilities : null
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
  const known = readLocalRuntimeCapabilitiesOrUnknown()
  if (known !== null) {
    return known
  }
  await refreshLocalRuntimeCapabilities()
  return readLocalRuntimeCapabilitiesOrUnknown()
}

/** Resolves with the capabilities once a probe lands them, probing once now; a failed probe does
 *  not end the wait, since the next probe anyone makes still answers it. `stop` drops the wait. */
export function awaitLocalRuntimeCapabilities(): {
  known: Promise<readonly RuntimeCapability[]>
  stop: () => void
} {
  let stop = (): void => {}
  const known = new Promise<readonly RuntimeCapability[]>((resolve) => {
    const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
    if (capabilities !== null) {
      resolve(capabilities)
      return
    }
    stop = subscribeLocalRuntimeCapabilitiesKnown((capabilities) => {
      stop()
      resolve(capabilities)
    })
    void refreshLocalRuntimeCapabilities()
  })
  return { known, stop: () => stop() }
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
      const capabilities = [...(status.capabilities ?? [])]
      publish({ state: 'known', capabilities })
      knownListeners.forEach((listener) => listener(capabilities))
      return capabilities
    })
    .catch(() => {
      // Stays unknown rather than becoming an empty (== unsupported) list: a failed probe
      // is not evidence about the host.
      publish({ state: 'unavailable' })
      return []
    })
    .finally(() => {
      refreshPromise = null
    })
  if (observation.state === 'unlearned') {
    publish({ state: 'pending' })
  }
  return refreshPromise
}

export function setLocalRuntimeCapabilitiesForTests(
  capabilities: readonly RuntimeCapability[] | null
): void {
  observation =
    capabilities === null
      ? { state: 'unlearned' }
      : { state: 'known', capabilities: [...capabilities] }
  refreshPromise = null
}
