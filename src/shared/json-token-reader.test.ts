import { expect, it } from 'vitest'
import { FlexAssembler } from 'stream-json/core/utils/flex-assembler.js'
import { createJsonTokenReader } from './json-token-reader'

it.each([1, 7, 64 * 1024, Infinity])('preserves Unicode at chunk size %s', (size) => {
  const value = { '\ufeffkey': `\ufeffstart${'\n'.repeat(64 * 1024)}\ufeff😀end` }
  const literal = JSON.stringify(value)
  for (const text of [literal, literal.replaceAll('\ufeff', '\\uFEFF')]) {
    const assembler = new FlexAssembler()
    const reader = createJsonTokenReader((token) => {
      assembler.consume(token)
    })
    for (let offset = 0; offset < text.length; offset += size) {
      reader.write(text.slice(offset, offset + size))
    }
    reader.end()
    expect(assembler.current).toEqual(value)
  }
})

it.each(['', ' ', '{', '{"a":1,}', '{}{}', '[01]', '\ufeff{}'])(
  'rejects malformed JSON %j as a syntax error',
  (text) => {
    const reader = createJsonTokenReader(() => {})
    expect(() => {
      reader.write(text)
      reader.end()
    }).toThrow(SyntaxError)
  }
)

it('preserves consumer errors and completes numbers at EOF synchronously', () => {
  const values: string[] = []
  const reader = createJsonTokenReader((token) => {
    if (token.name === 'numberValue') {
      values.push(token.value)
    }
  })
  reader.write('12')
  reader.end()
  expect(values).toEqual(['12'])
  const failure = new RangeError('consumer failure')
  const throwing = createJsonTokenReader(() => {
    throw failure
  })
  expect(() => throwing.write('{}')).toThrow(failure)
})
