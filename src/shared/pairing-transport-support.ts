import type { PairingOffer } from './mobile-relay-pairing-offer'

export const PAIRING_TUNNEL_UNSUPPORTED_MESSAGE =
  'This link uses a Tailcat tunnel, which only the Orca desktop app can dial. Pair from Orca on a computer, or generate a link without Tailcat.'

/** Clients without a tunnel dialer (browser, mobile) must refuse tunnel offers instead of dialing the fallback. */
export function getUnsupportedPairingTransportMessage(offer: PairingOffer): string | null {
  return offer.tunnel ? PAIRING_TUNNEL_UNSUPPORTED_MESSAGE : null
}
