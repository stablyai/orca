import { describe, expect, it } from 'vitest'
import { isExactMobileWebJsonDocument } from './exact-json-document'

describe('exact mobile web JSON document', () => {
  it.each([
    'null',
    'true',
    'false',
    '0',
    '-12.5e+3',
    '""',
    '"plain"',
    '"\\uD83D\\uDE80"',
    '"🚀"',
    '[]',
    '{}',
    '{"nested":[1,true,null,{"value":"ok"}]}',
    `${'['.repeat(32)}0${']'.repeat(32)}`
  ])('accepts exact JSON case %#', (value) => {
    expect(isExactMobileWebJsonDocument(value)).toBe(true)
  })

  it.each([
    '',
    'undefined',
    '01',
    '1.',
    '.1',
    '1e',
    '{"value":1,}',
    '[1,]',
    '{"value":1} trailing',
    '{"value":1,"value":2}',
    '{"value":1,"\\u0076alue":2}',
    '"\\uD800"',
    '"\\uDC00"',
    '"\\uD800\\uD800"',
    `"${String.fromCharCode(0xd800)}"`,
    `"${String.fromCharCode(0xdc00)}"`,
    `${'['.repeat(33)}0${']'.repeat(33)}`
  ])('rejects ambiguous or malformed JSON case %#', (value) => {
    expect(isExactMobileWebJsonDocument(value)).toBe(false)
  })
})
