// A shared agent's host has no pairing on disk: main knows it by its share, and reaches it as a paired
// server over Relay, signing in with the device key that share keeps. Its environment's endpoint
// carries a token naming the share in place of a device token, so the paired path signs in by key.
import type { PairedE2EEDeviceKeyCredential } from '../e2ee/paired-e2ee-client-handshake'
import type { RuntimeRelayCredentialStore } from '../control/remote-runtime-relay-authenticated-channel'
import type { KnownRuntimeEnvironment } from '../host-catalog/runtime-environments'
import type { PairedRuntimeConnection } from './paired-runtime-connection'
import type { PairingRelay } from './mobile-relay-pairing-offer'
import { runtimeRelayEndpoint } from './runtime-relay-endpoint'

const SHARED_HOST_TOKEN_PREFIX = 'shared-host:'

export type SharedHost = {
  name: string
  /** The host's latest offer: its Relay reach and key, and this device's id there. */
  offer: { relay: PairingRelay; hostPublicKeyB64: string; deviceId: string }
  credential: PairedE2EEDeviceKeyCredential
  /** The share's Relay invite and resume credential, kept with its entry. */
  relay: RuntimeRelayCredentialStore
}

let hosts: ((environmentId: string) => SharedHost | null) | null = null

/** Set once by the desktop's shared-agents owner; null elsewhere, and in tests that end. */
export function setSharedHosts(lookup: ((environmentId: string) => SharedHost | null) | null) {
  hosts = lookup
}

export function sharedHostKey(environmentId: string): SharedHost | null {
  return hosts?.(environmentId) ?? null
}

/** A shared host as a paired server: resolved by its id like one, never written to the store. */
export function sharedHostEnvironment(environmentId: string): KnownRuntimeEnvironment | null {
  const host = sharedHostKey(environmentId)
  if (!host) {
    return null
  }
  const endpointId = 'relay'
  return {
    id: environmentId,
    name: host.name,
    createdAt: 0,
    updatedAt: 0,
    pairedDeviceId: host.offer.deviceId,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: endpointId,
        kind: 'websocket',
        label: 'Relay',
        endpoint: runtimeRelayEndpoint(host.offer.relay),
        deviceToken: `${SHARED_HOST_TOKEN_PREFIX}${environmentId}`,
        publicKeyB64: host.offer.hostPublicKeyB64
      }
    ],
    preferredEndpointId: endpointId
  }
}

/** How the paired path signs in to an endpoint naming a shared host: by its share's device key, which
 *  fails to sign once the share is gone. Null for a pairing's own endpoint. */
export function sharedHostConnection(
  endpoint: { endpoint: string; deviceToken: string; publicKeyB64: string },
  pairedDeviceId: string | undefined
): PairedRuntimeConnection | null {
  if (!endpoint.deviceToken.startsWith(SHARED_HOST_TOKEN_PREFIX)) {
    return null
  }
  const environmentId = endpoint.deviceToken.slice(SHARED_HOST_TOKEN_PREFIX.length)
  return {
    endpoint: endpoint.endpoint,
    hostPublicKeyB64: endpoint.publicKeyB64,
    credential: sharedHostKey(environmentId)?.credential ?? {
      kind: 'device-key',
      deviceId: environmentId,
      sign: () => Promise.reject(new Error('This agent is no longer shared with you.'))
    },
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  }
}
