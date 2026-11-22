import { describe, expect, it } from 'vitest'
import { parseHandshakeMessage } from './protocol'

describe('handshake framing', () => {
  // Hostile JSON can make String(type) throw and hide the intended refusal diagnostic.
  it('still names the refusal when the peer type cannot be stringified', () => {
    const hostile = Buffer.from(JSON.stringify({ type: { toString: 1 } }))
    expect(() => parseHandshakeMessage(hostile)).toThrow(/Unknown handshake type: object/)
  })

  // Validate versions before pre-auth readers interpolate them into diagnostics.
  it('rejects a version that is not a string on both arms that carry one', () => {
    for (const type of ['orca-relay-handshake', 'orca-relay-handshake-ok']) {
      for (const version of [{ toString: 1 }, 7, null, undefined, ['0.1.0']]) {
        const payload = Buffer.from(JSON.stringify({ type, version }))
        expect(
          () => parseHandshakeMessage(payload),
          `${type} version=${JSON.stringify(version)}`
        ).toThrow(/Handshake field version is not a string/)
      }
    }
  })

  it('rejects a mismatch reply whose expected or got is not a string', () => {
    const type = 'orca-relay-handshake-mismatch'
    expect(() =>
      parseHandshakeMessage(Buffer.from(JSON.stringify({ type, expected: {}, got: 'b' })))
    ).toThrow(/Handshake field expected is not a string/)
    expect(() =>
      parseHandshakeMessage(Buffer.from(JSON.stringify({ type, expected: 'a', got: 1 })))
    ).toThrow(/Handshake field got is not a string/)
  })

  it('rejects payloads that are not objects', () => {
    for (const payload of ['null', '"orca-relay-handshake"', '42']) {
      expect(() => parseHandshakeMessage(Buffer.from(payload)), payload).toThrow(
        /Handshake payload is not an object/
      )
    }
  })

  // Validate optional credentials at the parser so future readers cannot encounter a hostile non-string.
  it('rejects a present endpointCredential that is not a string', () => {
    for (const endpointCredential of [{ toString: 1 }, 7, null, ['secret'], true]) {
      const payload = Buffer.from(
        JSON.stringify({ type: 'orca-relay-handshake', version: '0.1.0', endpointCredential })
      )
      expect(
        () => parseHandshakeMessage(payload),
        `endpointCredential=${JSON.stringify(endpointCredential)}`
      ).toThrow(/Handshake field endpointCredential is not a string/)
    }
  })

  it.each([['pinned-node'], [{ kind: 1, version: '24' }], [null]])(
    'refuses a present-but-malformed runtime %j',
    (runtime) => {
      const payload = Buffer.from(
        JSON.stringify({ type: 'orca-relay-handshake-ok', version: '0.1.0', runtime })
      )
      expect(() => parseHandshakeMessage(payload)).toThrow('runtime')
    }
  )
})
