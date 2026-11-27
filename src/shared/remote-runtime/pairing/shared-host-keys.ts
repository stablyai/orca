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

/** A process's kept shares: each one's host, their environment ids, and when they are loaded. */
export type SharedHostRegistry = {
  host: (environmentId: string) => SharedHost | null
  environmentIds: () => readonly string[]
  ready: () => Promise<void>
}

/** A process that never holds shares (a headless host's own profile). */
export const NO_SHARED_HOSTS: SharedHostRegistry = {
  host: () => null,
  environmentIds: () => [],
  ready: () => Promise.resolve()
}

let hosts: SharedHostRegistry | null = null
// Not Promise.withResolvers: shared code also runs on the phone's older WebKit.
let markRegistered = (): void => {}
let registered = new Promise<void>((resolve) => (markRegistered = resolve))
// The runtime each host last answered from, kept as a paired server's store keeps it: tab streams are
// fenced on it, and a host that restarted answers from a new one.
const answeredRuntimeIds = new Map<string, string>()

/** Set once by each process: the desktop's and `orca serve`'s kept shares, or NO_SHARED_HOSTS. Null
 *  only in tests that end. */
export function setSharedHosts(registry: SharedHostRegistry | null) {
  hosts = registry
  answeredRuntimeIds.clear()
  if (registry) {
    markRegistered()
  } else {
    registered = new Promise<void>((resolve) => (markRegistered = resolve))
  }
}

/** The one gate every reader of shared hosts passes: once this process said which shares it keeps
 *  and loaded them, so a share not read yet is never taken for one that ended. */
export async function sharedHostsReady(): Promise<void> {
  await registered
  await hosts?.ready().catch(() => undefined)
}

/** Records the runtime a shared host answered from; false for any other host. */
export function noteSharedHostRuntime(environmentId: string, runtimeId: string | null | undefined) {
  if (!sharedHostKey(environmentId)) {
    return false
  }
  if (runtimeId) {
    answeredRuntimeIds.set(environmentId, runtimeId)
  }
  return true
}

export function sharedHostKey(environmentId: string): SharedHost | null {
  return hosts?.host(environmentId) ?? null
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
    runtimeId: answeredRuntimeIds.get(environmentId) ?? null,
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

/** Every shared host this computer can reach now (its share has an offer), as paired servers list. */
export function listSharedHostEnvironments(): KnownRuntimeEnvironment[] {
  return (hosts?.environmentIds() ?? []).flatMap(
    (environmentId) => sharedHostEnvironment(environmentId) ?? []
  )
}

/** The one shared host with this name, for `--on <name>`; null when none or several have it. */
export function sharedHostEnvironmentNamed(name: string): KnownRuntimeEnvironment | null {
  const named = listSharedHostEnvironments().filter((environment) => environment.name === name)
  return named.length === 1 ? named[0] : null
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
      // Never reached over Relay: without its share there is no Relay credential to dial either.
      sign: () => Promise.reject(new Error('This agent is no longer shared with you.'))
    },
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  }
}
