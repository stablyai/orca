import { describe, expect, it } from 'vitest'
import { errnoCodeOrUnknown } from './errno-code'

describe('errnoCodeOrUnknown', () => {
  it.each([
    ['a plain error', new Error('boom')],
    ['a non-errno code', Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })],
    ['a numeric code', Object.assign(new Error('x'), { code: 11 })],
    ['a non-error throw', 'EAGAIN']
  ])('reports unknown for %s', (_label, error) => {
    expect(errnoCodeOrUnknown(error)).toBe('unknown')
  })
})
