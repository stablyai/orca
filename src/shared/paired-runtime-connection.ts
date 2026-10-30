import type { RuntimeRelayConnection } from './runtime-relay-connection'
import type { PairedE2EEAuthCredential } from './paired-e2ee-client-handshake'
import type { PairingOffer } from './pairing'

// Connections carry credentials that may evolve beyond tokens; PairingOffer describes pairing input instead.
export type PairedRuntimeConnection = {
  endpoint: string
  hostPublicKeyB64: string
  credential: PairedE2EEAuthCredential
  relayConnection?: RuntimeRelayConnection
  pairedDeviceId?: string
}

type OfferConnectionFields = Pick<
  PairingOffer,
  'endpoint' | 'deviceToken' | 'publicKeyB64' | 'pairedDeviceId'
> &
  Partial<Pick<PairingOffer, 'v' | 'scope' | 'relay'>>

export function pairedRuntimeConnectionFromOffer(
  offer: OfferConnectionFields,
  savedRelay?: RuntimeRelayConnection
): PairedRuntimeConnection {
  const relay = offer.relay
  const relayConnection: RuntimeRelayConnection | undefined =
    savedRelay ??
    (relay
      ? {
          v: 1,
          directorUrl: relay.directorUrl,
          cellUrl: relay.cellUrl,
          assignmentEpoch: relay.assignmentEpoch,
          relayHostId: relay.relayHostId,
          e2eeFraming: 2,
          credential: relay.inviteToken,
          credentialKind: 'invite'
        }
      : undefined)
  return {
    ...(relayConnection ? { relayConnection } : {}),
    endpoint: offer.endpoint,
    hostPublicKeyB64: offer.publicKeyB64,
    credential: { kind: 'token', deviceToken: offer.deviceToken },
    ...(offer.pairedDeviceId ? { pairedDeviceId: offer.pairedDeviceId } : {})
  }
}

// The token request envelopes still carry on the wire.
export function pairedRuntimeConnectionToken(connection: PairedRuntimeConnection): string {
  return connection.credential.deviceToken
}
