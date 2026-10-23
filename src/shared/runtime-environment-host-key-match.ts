import type { PairingOffer } from './pairing'
import type { KnownRuntimeEnvironment } from './runtime-environments'

/**
 * The saved server holding this host key. Why the key: it is the server's persisted identity,
 * so two pairings carrying it are one server whatever endpoint or name each was saved under.
 */
export function findEnvironmentWithHostKey<T extends Pick<KnownRuntimeEnvironment, 'endpoints'>>(
  environments: readonly T[],
  publicKeyB64: string
): T | undefined {
  const key = canonicalHostKeyB64(publicKeyB64)
  return environments.find((environment) =>
    environment.endpoints.some((endpoint) => canonicalHostKeyB64(endpoint.publicKeyB64) === key)
  )
}

/** Why: pairing links accept unpadded and URL-safe Base64, which decode to the same key. */
function canonicalHostKeyB64(publicKeyB64: string): string {
  return publicKeyB64.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
}

/**
 * The spelling a saved server already holds for this offer's key. Why: the host-key fingerprint
 * hashes the string, so a respelled key would read as another machine and retire its workspaces.
 */
export function savedHostKeySpelling(
  environment: Pick<KnownRuntimeEnvironment, 'endpoints'>,
  offer: Pick<PairingOffer, 'publicKeyB64'>
): string {
  const key = canonicalHostKeyB64(offer.publicKeyB64)
  return (
    environment.endpoints.find((endpoint) => canonicalHostKeyB64(endpoint.publicKeyB64) === key)
      ?.publicKeyB64 ?? offer.publicKeyB64
  )
}
