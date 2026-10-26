import type { PairingOffer } from './pairing'
import type { KnownRuntimeEnvironment } from './runtime-environments'

/** Match persisted host-key identity: different saved names/endpoints can still describe one server. */
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

/** Retain saved key spelling: the fingerprint hashes its text, so respelling would retire the server’s workspaces. */
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
