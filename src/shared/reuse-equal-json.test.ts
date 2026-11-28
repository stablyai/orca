import { expect, it } from 'vitest'
import { reuseEqualJson } from './reuse-equal-json'

it('keeps renderer provenance distinct while sharing equal records from the same owner', () => {
  const owner = Symbol('origin')
  const old = { rows: [{ id: 'same', [owner]: { revision: 1 } }] }
  const next = { rows: [{ id: 'same', [owner]: { revision: 2 } }] }
  const published = reuseEqualJson(old, next)
  expect(published.rows[0][owner]).toEqual({ revision: 2 })
  expect(old.rows[0][owner]).toEqual({ revision: 1 })
  expect(reuseEqualJson(published, next)).toBe(published)
})
