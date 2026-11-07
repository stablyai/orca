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
  it('returns a code carrying a freshly generated token after the host accepts it', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, result: { deviceId: 'd' } })
    const saved = await exchangeRemotePairingTicket({
      pairingCode,
      offer,
      hostCapabilities: capable,
      send
    })
    const savedOffer = parsePairingCode(saved)!
    expect(savedOffer).toMatchObject({ endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64 })
    expect(savedOffer.deviceToken).toMatch(/^[0-9a-f]{48}$/)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'token', deviceToken: 'link-token' } }),
      'pairing.exchangeTicket',
      { deviceToken: savedOffer.deviceToken },
      expect.any(Number)
    )
    // Signs in with the new token right away, so the host retires the link before any downgrade.
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credential: { kind: 'token', deviceToken: savedOffer.deviceToken }
      }),
      'status.get',
      undefined,
      expect.any(Number)
    )
  })

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

  it('keeps the original code for older hosts, refusals and transport errors', async () => {
    const never = vi.fn()
    await expect(
      exchangeRemotePairingTicket({ pairingCode, offer, hostCapabilities: undefined, send: never })
    ).resolves.toBe(pairingCode)
    expect(never).not.toHaveBeenCalled()
    for (const send of [
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'internal_error', message: 'no' } }),
      vi.fn().mockRejectedValue(new Error('timed out'))
    ]) {
      await expect(
        exchangeRemotePairingTicket({ pairingCode, offer, hostCapabilities: capable, send })
      ).resolves.toBe(pairingCode)
    }
  })
})
