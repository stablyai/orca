import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message'

describe('errorMessage', () => {
  it('returns the message from Error instances', () => {
    expect(errorMessage(new Error('permission denied'))).toBe('permission denied')
  })

  it.each([
    ['plain failure', 'plain failure'],
    [404, '404'],
    [null, 'null'],
    [{ code: 'EFAIL' }, '[object Object]']
  ])('stringifies non-Error values', (value, expected) => {
    expect(errorMessage(value)).toBe(expected)
  })
})
