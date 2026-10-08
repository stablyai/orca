/**
 * A re-paired environment (a managed server's update rotates its pairing) gets a new pairing
 * revision in main. Every renderer request carries the revision it last read, so until the
 * renderer re-reads the catalog each retry is refused the same way. The first refusal re-reads
 * it; subscribers keyed on the revision then resubscribe and requests use the new pairing.
 */
const PAIRING_CHANGED_MESSAGE = 'Runtime environment pairing changed'

type CatalogRefresher = () => Promise<void>

let refreshCatalog: CatalogRefresher | null = null
let inFlight: Promise<void> | null = null

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
  if (!refreshCatalog || !isRuntimeEnvironmentPairingChangedError(error)) {
    return Promise.resolve()
  }
  inFlight ??= refreshCatalog()
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
