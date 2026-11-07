import { describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from './mobile-relay-pairing-offer'
import { encodePairingOffer, parsePairingCode } from './pairing'
import { exchangeRemotePairingTicket } from './remote-pairing-ticket-exchange'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY } from './ticket-exchange-capability'

const offer: PairingOffer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'link-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
}
const pairingCode = encodePairingOffer(offer)
const capable = [PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY]

describe('exchangeRemotePairingTicket', () => {
  it('keeps the new token when the follow-up sign-in fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { deviceId: 'd' } })
      .mockRejectedValueOnce(new Error('timed out'))
    const saved = await exchangeRemotePairingTicket({
      pairingCode,
      offer,
      hostCapabilities: capable,
      send
    })
    expect(parsePairingCode(saved)?.deviceToken).toMatch(/^[0-9a-f]{48}$/)
  })
})
