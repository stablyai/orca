import { expect, it } from 'vitest'
import { jsonUtf8ByteLength } from './node-json-utf8-byte-length'

it('matches the UTF-8 size of JSON.stringify output', () => {
  // {"text":"a\"é\n\u0001","list":[null,1.5,null,null],"at":"1970-01-01T00:00:00.000Z","pair":"😀","lone":"\ud800","ké":true}
  const value = {
    text: 'a"é\n\u0001',
    list: [undefined, 1.5, Number.NaN, () => 0],
    skip: undefined,
    at: new Date(0),
    pair: '😀',
    lone: '\ud800',
    ké: true
  }
  expect(jsonUtf8ByteLength(value)).toBe(125)
})

it('rejects what JSON.stringify rejects', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(() => jsonUtf8ByteLength(cycle)).toThrow(TypeError)
  expect(() => jsonUtf8ByteLength({ count: 1n })).toThrow(TypeError)
  expect(() => jsonUtf8ByteLength(undefined)).toThrow(TypeError)
})
