import { expect } from 'vitest'

/** Store reads answer `undefined` only when obsolete; a test expecting an answer asserts one, then uses it. */
export function answered<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) {
    throw new Error('Expected the store read to answer, but it was obsolete.')
  }
  return value
}
