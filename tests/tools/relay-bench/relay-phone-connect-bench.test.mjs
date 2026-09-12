// Why: decodeOffer used to be `pairingUrl.split('code=')[1]` fed straight to JSON.parse, so a
// missing or malformed pairing link surfaced as a stack trace rather than usage. The link is a
// live credential, so the failure text has to name the problem without echoing the code.
import { describe, expect, it, vi } from 'vitest'
import {
  decodeOffer,
  describeRemoteErrorCode,
  parsePeerJson,
  vetCellUrl,
  vetRelayEndpoint
} from './relay-phone-connect-bench.mjs'

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

// Why: the cell URL from /v1/resolve carries the resume credential to whatever it names, so it
// gets the same DNS layer as a probe origin, not just the literal-address check.
describe('vetCellUrl', () => {
  it('refuses a literal private cell before any lookup', async () => {
    const lookup = vi.fn()
    const verdict = await vetCellUrl('https://10.0.0.5', { lookup })
    expect(verdict.ok).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses a public-looking cell name that resolves into the operator network', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '192.168.1.20', family: 4 }])
    const verdict = await vetCellUrl('https://cell.example', { lookup })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('192.168.1.20')
  })

  it('returns the normalized origin for a cell that resolves publicly', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    await expect(vetCellUrl('https://Cell.Example/', { lookup })).resolves.toEqual({
      ok: true,
      origin: 'https://cell.example'
    })
  })
})

// Why: the desktop's getEndpoints reply names the director every later resolve posts the resume
// token to. It gets the same two-layer check as the cell, in pair() and again on load.
describe('vetRelayEndpoint', () => {
  it('refuses a director that resolves into the operator network even when the cell is fine', async () => {
    const lookup = vi.fn(async (host) =>
      host === 'director.example'
        ? [{ address: '10.0.0.7', family: 4 }]
        : [{ address: '8.8.8.8', family: 4 }]
    )
    const verdict = await vetRelayEndpoint(
      { cellUrl: 'https://cell.example', directorUrl: 'https://director.example' },
      { lookup }
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('director')
    expect(verdict.reason).toContain('10.0.0.7')
  })

  it('accepts an endpoint whose cell and director both resolve publicly', async () => {
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
    await expect(
      vetRelayEndpoint(
        { cellUrl: 'https://cell.example', directorUrl: 'https://director.example' },
        { lookup }
      )
    ).resolves.toEqual({ ok: true })
  })
})

describe('describeRemoteErrorCode', () => {
  it('echoes a plain protocol identifier', () => {
    expect(describeRemoteErrorCode('invalid_install_req')).toBe('invalid_install_req')
  })

  it('never echoes terminal control bytes the peer put in the code', () => {
    const out = describeRemoteErrorCode('\u001b[2J\u001b]0;pwned\u0007')
    expect(out).not.toContain('\u001b')
    expect(out).toMatch(/unprintable code/)
  })

  it('names the type instead of stringifying a non-string code', () => {
    expect(describeRemoteErrorCode({ toString: () => '\u001b[31m' })).toBe(
      'non-string code (object)'
    )
    expect(describeRemoteErrorCode(undefined)).toBe('unknown')
  })
})

describe('parsePeerJson', () => {
  it('never lets the parser quote the peer bytes in the failure', () => {
    // JSON.parse's SyntaxError includes a fragment of its input; the relay chose that input.
    expect(() => parsePeerJson('x\u001b[2J', 'relay hello')).toThrow(
      /^relay hello: not valid JSON$/
    )
    expect(() => parsePeerJson('{"resumeToken":"secret"', 'state file')).toThrow(
      /^state file: not valid JSON$/
    )
  })

  it('parses valid JSON unchanged', () => {
    expect(parsePeerJson('{"ok":true}', 'relay hello')).toEqual({ ok: true })
  })
})
