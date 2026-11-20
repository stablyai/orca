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

it('sizes toJSON, boxed values and self-mutating arrays as JSON.stringify serializes them', () => {
  // {"f":"xy","b":true,"s":"longer"}
  const exotic = {
    f: Object.assign(() => 0, { toJSON: () => 'xy' }),
    b: Object.assign(new Boolean(true), { valueOf: () => false }),
    s: Object.assign(new String('a'), { toString: () => 'longer' })
  }
  expect(jsonUtf8ByteLength(exotic)).toBe(32)
  // [0,null,null]: the length is read once, before the getter shrinks the array.
  const shrinking = [0, 1, 2]
  Object.defineProperty(shrinking, 0, {
    enumerable: true,
    get() {
      shrinking.length = 1
      return 0
    }
  })
  expect(jsonUtf8ByteLength(shrinking)).toBe(13)
})

it('rejects what JSON.stringify rejects', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(() => jsonUtf8ByteLength(cycle)).toThrow(TypeError)
  expect(() => jsonUtf8ByteLength({ count: 1n })).toThrow(TypeError)
  expect(() => jsonUtf8ByteLength({ count: Object(1n) })).toThrow(TypeError)
  expect(() => jsonUtf8ByteLength(undefined)).toThrow(TypeError)
})
