import { describe, expect, it } from 'vitest'
import { parseOsc52 } from './osc52-clipboard'

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}

describe('parseOsc52', () => {
  it('decodes the canonical clipboard write payload', () => {
    const result = parseOsc52(`c;${b64('hello world')}`)
    expect(result).toEqual({ kind: 'write', selections: 'c', text: 'hello world' })
  })

  it('preserves multi-byte UTF-8', () => {
    const result = parseOsc52(`c;${b64('café — 日本語')}`)
    expect(result).toEqual({ kind: 'write', selections: 'c', text: 'café — 日本語' })
  })

  it('accepts combined selection letters (e.g. primary + clipboard)', () => {
    const result = parseOsc52(`pc;${b64('dual')}`)
    expect(result).toEqual({ kind: 'write', selections: 'pc', text: 'dual' })
  })

  it('accepts numeric select-buffer indices', () => {
    const result = parseOsc52(`s0;${b64('buffered')}`)
    expect(result).toEqual({ kind: 'write', selections: 's0', text: 'buffered' })
  })

  it('flags clipboard queries without decoding — we must not answer them', () => {
    // Why: answering would leak the user's clipboard to any process writing
    // to the PTY. The lifecycle handler drops queries on the floor.
    expect(parseOsc52('c;?')).toEqual({ kind: 'query' })
  })

  it('tolerates whitespace in the base64 payload', () => {
    const encoded = b64('multi-line data that got wrapped')
    const wrapped = `${encoded.slice(0, 10)}\n${encoded.slice(10)}`
    const result = parseOsc52(`c;${wrapped}`)
    expect(result).toEqual({
      kind: 'write',
      selections: 'c',
      text: 'multi-line data that got wrapped'
    })
  })

  it('rejects missing separator', () => {
    expect(parseOsc52(b64('no-semicolon'))).toMatchObject({ kind: 'invalid' })
  })

  it('rejects empty selection list', () => {
    // Why: the spec defaults to "s0" on empty, but treating malformed
    // payloads as clipboard writes would let buggy/malicious emitters
    // mutate the clipboard unintentionally.
    expect(parseOsc52(`;${b64('x')}`)).toMatchObject({ kind: 'invalid' })
  })

  it('rejects unknown selection letters', () => {
    expect(parseOsc52(`x;${b64('x')}`)).toMatchObject({ kind: 'invalid' })
  })

  it('rejects non-base64 garbage', () => {
    expect(parseOsc52('c;!!!not-base64!!!')).toMatchObject({ kind: 'invalid' })
  })

  it('rejects payloads larger than the size cap', () => {
    const huge = 'A'.repeat(128 * 1024 + 100) // valid base64 alphabet char
    expect(parseOsc52(`c;${huge}`)).toMatchObject({ kind: 'invalid' })
  })
})
