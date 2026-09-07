// Why: decodeOffer used to be `pairingUrl.split('code=')[1]` fed straight to JSON.parse, so a
// missing or malformed pairing link surfaced as a stack trace rather than usage. The link is a
// live credential, so the failure text has to name the problem without echoing the code.
import { describe, expect, it } from 'vitest'
import { decodeOffer } from './relay-phone-connect-bench.mjs'

const encode = (offer) => Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url')

describe('decodeOffer', () => {
  it('decodes a well-formed pairing link', () => {
    const offer = { relay: { cellUrl: 'https://cell.example', relayHostId: 'A'.repeat(16) } }
    expect(decodeOffer(`orca://pair?code=${encode(offer)}`)).toEqual(offer)
  })

  it('ignores parameters after the code', () => {
    const offer = { deviceToken: 'token' }
    expect(decodeOffer(`orca://pair?code=${encode(offer)}&v=2`)).toEqual(offer)
  })

  it.each([
    [undefined, /orca:\/\/pair/],
    ['', /orca:\/\/pair/],
    ['https://example.com/?code=abc', /orca:\/\/pair/],
    ['orca://pair', /no code= parameter/],
    ['orca://pair?code=', /not base64url/],
    ['orca://pair?code=not base64', /not base64url/],
    [`orca://pair?code=${Buffer.from('not json').toString('base64url')}`, /did not decode to JSON/],
    [`orca://pair?code=${Buffer.from('[1,2]').toString('base64url')}`, /offer object/],
    [`orca://pair?code=${Buffer.from('null').toString('base64url')}`, /offer object/]
  ])('refuses %j', (value, message) => {
    expect(() => decodeOffer(value)).toThrow(message)
  })
})
