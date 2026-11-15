// Main rotates pairing revisions during managed updates. First stale-revision refusal refreshes renderer catalog, letting revision-keyed subscribers reconnect and requests use current credentials.
const PAIRING_CHANGED_MESSAGE = 'Runtime environment pairing changed'

type CatalogRefresher = () => Promise<void>

let refreshCatalog: CatalogRefresher | null = null
let inFlight: Promise<void> | null = null
let trailing: Promise<void> | null = null

export function setRuntimeEnvironmentCatalogRefresher(refresher: CatalogRefresher | null): void {
  refreshCatalog = refresher
}

export function runtimeEnvironmentPairingChangedError(): Error {
  return new Error(`${PAIRING_CHANGED_MESSAGE}; refresh and try again`)
}

export function isRuntimeEnvironmentPairingChangedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes(PAIRING_CHANGED_MESSAGE)
}

/** Re-reads the catalog once per burst of refusals; resolves when the new revisions are in. */
export function refreshRuntimeEnvironmentsAfterPairingChange(error: unknown): Promise<void> {
  return isRuntimeEnvironmentPairingChangedError(error)
    ? refreshRuntimeEnvironmentCatalog()
    : Promise.resolve()
}

/** One catalog re-read for every caller that learned of a new pairing at the same time. */
export function refreshRuntimeEnvironmentCatalog(): Promise<void> {
  if (!refreshCatalog) {
    return Promise.resolve()
  }
  if (inFlight) {
    // The running read may predate this caller's change, so queue one more for the whole burst.
    trailing ??= inFlight.then(() => {
      trailing = null
      return refreshRuntimeEnvironmentCatalog()
    })
    return trailing
  }
  inFlight = refreshCatalog()
    .catch((refreshError: unknown) => {
      console.warn(
        '[runtime-environments] Could not re-read a re-paired environment:',
        refreshError
      )
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** `runtimeEnvironments.subscribe`, re-reading the catalog when the pairing changed under it. */
export function subscribeRuntimeEnvironment(
  ...args: Parameters<typeof window.api.runtimeEnvironments.subscribe>
): ReturnType<typeof window.api.runtimeEnvironments.subscribe> {
  return observePairingRefusal(window.api.runtimeEnvironments.subscribe(...args))
}

/**
 * Returns `request` itself: a side branch watches for a refusal, so a successful request settles
 * on the same tick as before and the caller still sees the original rejection.
 */
export function observePairingRefusal<T>(request: Promise<T>): Promise<T> {
  request.catch((error: unknown) => {
    void refreshRuntimeEnvironmentsAfterPairingChange(error)
  })
  return request
}
