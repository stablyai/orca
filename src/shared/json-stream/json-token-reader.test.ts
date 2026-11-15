import { expect, it } from 'vitest'

import { createJsonTokenReader } from './json-token-reader'

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

it('preserves selective scalar consumer errors and a number ending at EOF', () => {
  const values: string[] = []
  const reader = createJsonTokenReader(
    (token) => {
      if (token.name === 'numberValue') {
        values.push(token.value)
      }
    },
    1,
    () => true
  )
  reader.write('-12.5e+2')
  reader.end()
  expect(values).toEqual(['-12.5e+2'])
  const failure = new RangeError('selective consumer failure')
  const throwing = createJsonTokenReader(
    (token) => {
      if (token.name === 'stringValue') {
        throw failure
      }
    },
    1,
    () => true
  )
  expect(() => throwing.write('"kept"')).toThrow(failure)
})
