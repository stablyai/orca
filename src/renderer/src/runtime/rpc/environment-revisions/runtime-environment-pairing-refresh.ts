// Main rotates pairing revisions during managed updates. First stale-revision refusal refreshes renderer catalog, letting revision-keyed subscribers reconnect and requests use current credentials.
import { hasRecentUserGestureFor } from '../calls/runtime-rpc-background-read'
const PAIRING_CHANGED_MESSAGE = 'Runtime environment pairing changed'

type CatalogRefresher = () => Promise<void>

let refreshCatalog: CatalogRefresher | null = null
let inFlight: Promise<boolean> | null = null
let trailing: Promise<boolean> | null = null

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
export async function refreshRuntimeEnvironmentCatalog(): Promise<void> {
  await refreshRuntimeEnvironmentCatalogWithResult()
}

/** The shared fresh read, with failure and an unavailable refresher reported to recovery callers. */
export function refreshRuntimeEnvironmentCatalogWithResult(): Promise<boolean> {
  if (!refreshCatalog) {
    return Promise.resolve(false)
  }
  if (inFlight) {
    // The running read may predate this caller's change, so queue one more for the whole burst.
    trailing ??= inFlight.then(() => {
      trailing = null
      return refreshRuntimeEnvironmentCatalogWithResult()
    })
    return trailing
  }
  inFlight = readCatalog(refreshCatalog).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function readCatalog(refresh: CatalogRefresher): Promise<boolean> {
  try {
    await refresh()
    return true
  } catch (error) {
    console.warn('[runtime-environments] Could not re-read a re-paired environment:', error)
    return false
  }
}

/** `runtimeEnvironments.subscribe`, re-reading the catalog when the pairing changed under it. */
export function subscribeRuntimeEnvironment(
  ...[args, callbacks]: Parameters<typeof window.api.runtimeEnvironments.subscribe>
): ReturnType<typeof window.api.runtimeEnvironments.subscribe> {
  // Like a call, a stream opened while the user acts may wake an idle-stopped WSL host.
  const wake = args.wake ?? (!args.background && hasRecentUserGestureFor(args.selector))
  return observePairingRefusal(
    window.api.runtimeEnvironments.subscribe(wake ? { ...args, wake } : args, callbacks)
  )
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
