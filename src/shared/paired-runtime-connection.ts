import type { PairedE2EEAuthCredential } from './paired-e2ee-client-handshake'
import type { PairingOffer } from './pairing'

// What a client needs to connect to a paired host. Why not PairingOffer: an offer is
// pairing input; a connection carries a credential that will not always be a token.
export type PairedRuntimeConnection = {
  endpoint: string
  hostPublicKeyB64: string
  credential: PairedE2EEAuthCredential
  pairedDeviceId?: string
}

type OfferConnectionFields = Pick<
  PairingOffer,
  'endpoint' | 'deviceToken' | 'publicKeyB64' | 'pairedDeviceId'
> &
  Partial<Pick<PairingOffer, 'v' | 'scope'>>

export function pairedRuntimeConnectionFromOffer(
  offer: OfferConnectionFields
): PairedRuntimeConnection {
  return {
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
