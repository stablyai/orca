import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { WebRuntimeClient } from '../web/web-runtime-client'
import { setEndpointOverride } from '../web/web-runtime-endpoint-overrides'
import {
  closeActiveRuntimeClients,
  getClientForEnvironment,
  webRuntimeState
} from '../web/preload-api/web-runtime-session'

const HEAL_PROBE_TIMEOUT_MS = 8_000

// Why: the web bundle is served by an orcad — `ws(s)://<origin>` reaches that host by
// construction, so it is always a candidate endpoint for the stored pairing.
export function servingOriginWebSocketEndpoint(): string | null {
  const { protocol, host } = window.location
  if (!host || (protocol !== 'http:' && protocol !== 'https:')) {
    return null
  }
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`
}

/**
 * Re-points the active environment at the serving origin when its stored endpoint is
 * dead — the common case being orcad relaunched on a different port. The stored device
 * token/pinned host key still authenticate that runtime on the new address, and only
 * the issuing host accepts them, so an answered `status.get` is itself the proof. On
 * success the redirect is recorded as an endpoint override (mutating `endpoints` would
 * be clobbered by the server-store merge resurrecting the stale entry), the cached
 * client is rebuilt, and the status listener in the caller sees `ready` and reloads.
 */
export async function healUnreachableActiveEnvironment(args: {
  isCancelled: () => boolean
  abortSignal: AbortSignal
}): Promise<void> {
  const environment = webRuntimeState.activeEnvironment
  const originEndpoint = servingOriginWebSocketEndpoint()
  if (!environment || !originEndpoint) {
    return
  }
  const preferred =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!preferred || preferred.endpoint === originEndpoint) {
    return
  }
  const probe = new WebRuntimeClient(
    {
      v: 2,
      endpoint: originEndpoint,
      deviceToken: preferred.deviceToken,
      publicKeyB64: preferred.publicKeyB64,
      ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
    },
    { reconnect: false }
  )
  try {
    const response: RuntimeRpcResponse<unknown> = await probe.call('status.get', undefined, {
      timeoutMs: HEAL_PROBE_TIMEOUT_MS
    })
    if (args.isCancelled() || args.abortSignal.aborted) {
      return
    }
    // An authenticated answer is the identity proof — a different Orca rejects the
    // token outright (and runtimeId rotates every boot, so it cannot be compared).
    if (!response.ok) {
      return
    }
    setEndpointOverride(environment.id, {
      endpoint: originEndpoint,
      forEndpoint: preferred.endpoint
    })
    closeActiveRuntimeClients()
    getClientForEnvironment(environment)
  } catch {
    // Why: a refused/timed-out probe means the origin is not this runtime — stay offline
    // and let the stored endpoint's own reconnect keep trying.
  } finally {
    probe.close()
  }
}
