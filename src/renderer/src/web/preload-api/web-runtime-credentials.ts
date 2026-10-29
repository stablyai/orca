import { readWebDeviceKeySupport } from '../web-device-key-support'
import {
  createIndexedDbWebDeviceKeyStore,
  createMemoryWebDeviceKeyStore,
  type WebDeviceKeyStore
} from '../web-device-key-store'
import {
  createWebRuntimeCredentialSource,
  tokenOnlyCredentialSource,
  type WebRuntimeCredentialSource
} from '../web-runtime-credential-source'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'

let keyStore: WebDeviceKeyStore | null = null
const sources = new Map<string, WebRuntimeCredentialSource>()

/** Share credentials across primary/helper sockets; key by pairing revision so re-pair starts fresh. */
export function webRuntimeCredentialFor(
  environment: StoredWebRuntimeEnvironment,
  callbacks: {
    forgetStoredToken: (deviceId: string) => void
    forgetPairing: () => void
  }
): WebRuntimeCredentialSource {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  const cacheKey = `${environment.id}\0${environment.pairingRevision ?? environment.createdAt}\0${endpoint?.publicKeyB64}`
  const existing = sources.get(cacheKey)
  if (existing) {
    return existing
  }
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  const support = readWebDeviceKeySupport()
  if (!support || support === 'token-insecure-origin') {
    return tokenOnlyCredentialSource(endpoint.deviceToken)
  }
  keyStore ??=
    typeof indexedDB === 'undefined'
      ? createMemoryWebDeviceKeyStore()
      : createIndexedDbWebDeviceKeyStore(indexedDB)
  const source = createWebRuntimeCredentialSource({
    environment: {
      environmentId: environment.id,
      hostPublicKeyB64: endpoint.publicKeyB64,
      deviceToken: endpoint.deviceToken,
      pairingRevision: environment.pairingRevision ?? environment.createdAt,
      storage: environment.sessionOnly ? 'session' : 'persisted'
    },
    support,
    store: keyStore,
    subtle: typeof crypto === 'undefined' ? null : crypto.subtle,
    ...callbacks
  })
  sources.set(cacheKey, source)
  return source
}
