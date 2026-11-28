import * as z from 'zod'
import { unshippedTestSwitchOn } from '../../app-lifecycle/unshipped-test-switch'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { PAIRING_RELAY_OFFER_FIELDS, type PairingRelay } from './mobile-relay-pairing-offer'
import { encodePairingOffer, parsePairingCode } from './pairing'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/**
 * Test-only Relay reach for a paired runtime (dev builds, `ORCA_TEST_RUNTIME_RELAY_PAIRING`): the
 * host's cell, Relay host id and first invite, kept where a paired server keeps its address. No
 * socket opener can dial it, so a host reached this way is reached only over its Relay link.
 */
const RELAY_ENDPOINT_PREFIX = 'orca-relay:'
const RUNTIME_RELAY_PAIRING_TEST_SWITCH = 'ORCA_TEST_RUNTIME_RELAY_PAIRING'

/** Both sides: a host mints runtime offers with a Relay invite, a client pairs over it. */
export function runtimeRelayPairingTestSwitchOn(): boolean {
  return unshippedTestSwitchOn(RUNTIME_RELAY_PAIRING_TEST_SWITCH)
}

/** Token auth carries capabilities on direct sockets; over Relay only for the test pairing, so a
 *  phone's Relay auth keeps the exact v2 key set every host accepts. */
export function hostReadsTokenCapabilities(transport: 'direct' | 'relay'): boolean {
  return transport === 'direct' || runtimeRelayPairingTestSwitchOn()
}

/** Under the test switch, a paired desktop with a Relay binding reaches its host over Relay. */
export function isTestRelayRuntimeDevice(
  device: { scope: string; relayBinding?: unknown } | null | undefined
): boolean {
  return (
    device?.scope === 'runtime' &&
    device.relayBinding !== undefined &&
    runtimeRelayPairingTestSwitchOn()
  )
}

const RuntimeRelayReachSchema = lazyZodSchema(() =>
  z.object({
    cellUrl: PAIRING_RELAY_OFFER_FIELDS.cellUrl,
    relayHostId: PAIRING_RELAY_OFFER_FIELDS.relayHostId,
    inviteToken: PAIRING_RELAY_OFFER_FIELDS.inviteToken,
    inviteExpiresAt: z.number().int(),
    // Where the client asks for the host's current cell when the one it knows stops answering.
    directorUrl: PAIRING_RELAY_OFFER_FIELDS.directorUrl.optional(),
    assignmentEpoch: PAIRING_RELAY_OFFER_FIELDS.assignmentEpoch.optional()
  })
)

export type RuntimeRelayReach = z.infer<typeof RuntimeRelayReachSchema>

export function runtimeRelayEndpoint(relay: PairingRelay): string {
  const reach: RuntimeRelayReach = {
    cellUrl: relay.cellUrl,
    relayHostId: relay.relayHostId,
    inviteToken: relay.inviteToken,
    inviteExpiresAt: relay.inviteExpiresAt,
    directorUrl: relay.directorUrl,
    assignmentEpoch: relay.assignmentEpoch
  }
  return `${RELAY_ENDPOINT_PREFIX}${btoa(JSON.stringify(reach))}`
}

export function isRuntimeRelayEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(RELAY_ENDPOINT_PREFIX)
}

/** A host paired over Relay has no address to dial: anything that would open a socket to it refuses. */
export function relayOnlyEndpointRefusal(endpoint: string): RemoteRuntimeClientError | null {
  return isRuntimeRelayEndpoint(endpoint)
    ? new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        'This server is reached only over Relay, and its Relay link is not open.'
      )
    : null
}

export function parseRuntimeRelayEndpoint(endpoint: string): RuntimeRelayReach | null {
  if (!isRuntimeRelayEndpoint(endpoint)) {
    return null
  }
  try {
    const parsed = RuntimeRelayReachSchema.safeParse(
      JSON.parse(atob(endpoint.slice(RELAY_ENDPOINT_PREFIX.length)))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** What the UI and logs may show of an endpoint: a Relay one names its host, never its invite. */
export function redactRuntimeRelayEndpoint(endpoint: string): string {
  if (!isRuntimeRelayEndpoint(endpoint)) {
    return endpoint
  }
  const reach = parseRuntimeRelayEndpoint(endpoint)
  return `${RELAY_ENDPOINT_PREFIX}${reach?.relayHostId ?? 'invalid'}`
}

/** Under the test switch, a pairing code with a Relay invite pairs over Relay only. */
export function withTestRelayReach(pairingCode: string): string {
  const offer = runtimeRelayPairingTestSwitchOn() ? parsePairingCode(pairingCode) : null
  if (!offer?.relay) {
    return pairingCode
  }
  const { relay, ...direct } = offer
  return encodePairingOffer({ ...direct, endpoint: runtimeRelayEndpoint(relay) })
}
