import type {
  PairedE2EEAuthCredential,
  PairedE2EEDeviceKeyCredential
} from '../e2ee/paired-e2ee-client-handshake'
import type { PairingOffer } from './mobile-relay-pairing-offer'

// Connections carry credentials that may evolve beyond tokens; PairingOffer describes pairing input instead.
export type PairedRuntimeConnection = {
  endpoint: string
  hostPublicKeyB64: string
  /** A pairing's device token, or a device key (a shared agent's host, signed in by key alone). */
  credential: PairedE2EEAuthCredential | PairedE2EEDeviceKeyCredential
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

// The token request envelopes still carry on the wire; a keyed socket carries none.
export function pairedRuntimeConnectionToken(connection: PairedRuntimeConnection): string {
  return connection.credential.kind === 'token' ? connection.credential.deviceToken : ''
}

/** What names this pairing among the host's: its token, or its device key's id. */
export function pairedRuntimeConnectionIdentity(connection: PairedRuntimeConnection): string {
  return connection.credential.kind === 'token'
    ? connection.credential.deviceToken
    : `device-key:${connection.credential.deviceId}`
}
