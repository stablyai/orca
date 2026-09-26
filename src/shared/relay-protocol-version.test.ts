import { describe, expect, it } from 'vitest'
import {
  MIN_RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  describeRelayProtocolVersion,
  relayProtocolOffer,
  relayProtocolOfferAdmits
} from './relay-protocol-version'

describe('relay protocol version', () => {
  it('is a whole number at or above its own floor', () => {
    expect(Number.isSafeInteger(RELAY_PROTOCOL_VERSION)).toBe(true)
    expect(Number.isSafeInteger(MIN_RELAY_PROTOCOL_VERSION)).toBe(true)
    expect(RELAY_PROTOCOL_VERSION).toBeGreaterThanOrEqual(MIN_RELAY_PROTOCOL_VERSION)
  })

  it('offers its own range, so a same-build peer is admitted by negotiation as well as by hash', () => {
    expect(relayProtocolOfferAdmits(relayProtocolOffer())).toBe(true)
  })

  // The whole point of Release N: the stranded relay is always the OLDER side, and it must be
  // able to say yes on the first frame with no earlier round trip to downgrade in.
  it('admits a newer client whose range reaches back to this relay', () => {
    expect(relayProtocolOfferAdmits({ protocolVersion: 9, minProtocolVersion: 1 }, 1)).toBe(true)
    expect(relayProtocolOfferAdmits({ protocolVersion: 9, minProtocolVersion: 5 }, 1)).toBe(false)
  })

  it('admits a client older than this relay when the relay still falls in its range', () => {
    expect(relayProtocolOfferAdmits({ protocolVersion: 4, minProtocolVersion: 2 }, 3)).toBe(true)
    expect(relayProtocolOfferAdmits({ protocolVersion: 2, minProtocolVersion: 1 }, 3)).toBe(false)
  })

  it('treats a lone protocolVersion as a range of exactly one', () => {
    expect(relayProtocolOfferAdmits({ protocolVersion: 3 }, 3)).toBe(true)
    expect(relayProtocolOfferAdmits({ protocolVersion: 3 }, 2)).toBe(false)
    expect(relayProtocolOfferAdmits({ protocolVersion: 3 }, 4)).toBe(false)
  })

  // A peer that sends no offer predates negotiation; admitting it would hand every unversioned
  // caller the cross-build path that the build hash is supposed to gate.
  it('never admits an absent or empty offer', () => {
    expect(relayProtocolOfferAdmits(undefined, 1)).toBe(false)
    expect(relayProtocolOfferAdmits({}, 1)).toBe(false)
    expect(relayProtocolOfferAdmits({ minProtocolVersion: 1 }, 1)).toBe(false)
  })

  // Zero is the one bad value the band check cannot catch on its own: a peer claiming protocol 0
  // would be admitted by a relay whose own version was also read as 0.
  it('rejects a zero protocol version rather than treating it as a real version', () => {
    expect(relayProtocolOfferAdmits({ protocolVersion: 0, minProtocolVersion: 0 }, 0)).toBe(false)
  })

  it('rejects offers that are not plausible integers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000]) {
      expect(
        relayProtocolOfferAdmits({ protocolVersion: bad, minProtocolVersion: 1 }, 1),
        `protocolVersion=${bad}`
      ).toBe(false)
    }
    for (const bad of ['1', null, {}, []]) {
      expect(
        relayProtocolOfferAdmits(
          { protocolVersion: 1, minProtocolVersion: bad as unknown as number },
          1
        ),
        `minProtocolVersion=${JSON.stringify(bad)}`
      ).toBe(false)
    }
  })

  it('rejects an inverted range instead of silently reordering it', () => {
    expect(relayProtocolOfferAdmits({ protocolVersion: 1, minProtocolVersion: 5 }, 1)).toBe(false)
    expect(relayProtocolOfferAdmits({ protocolVersion: 1, minProtocolVersion: 5 }, 5)).toBe(false)
  })

  // A relay daemon logs the peer's claim on the refusal path, and `JSON.parse` can produce an
  // object a template literal cannot stringify. Throwing there is inside the frame-decoder
  // callback, which would take the daemon and every PTY it still holds down with it.
  it('renders a peer version claim that a template literal would throw on', () => {
    const hostile = JSON.parse('{"protocolVersion": {"toString": 1}}').protocolVersion
    expect(() => `${hostile}`).toThrow()
    expect(describeRelayProtocolVersion(hostile)).toBe('none')
  })

  it('renders real numbers and refuses every other shape', () => {
    expect(describeRelayProtocolVersion(7)).toBe('7')
    for (const bad of [undefined, null, '3', {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeRelayProtocolVersion(bad), JSON.stringify(bad ?? null)).toBe('none')
    }
  })
})
