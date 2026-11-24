import { describe, expect, it } from 'vitest'
import { normalizeClickUpPage } from './clickup-task-filter'

describe('normalizeClickUpPage', () => {
  it.each([
    [undefined, 0],
    [null, 0],
    [0, 0],
    [1000, 1000]
  ])('reads %s as page %s', (value, expected) => {
    expect(normalizeClickUpPage(value)).toBe(expected)
  })

  it.each([1001, -1, 1.5, '3', Number.NaN])('rejects %s instead of rereading page 0', (value) => {
    expect(() => normalizeClickUpPage(value)).toThrow('Page must be an integer from 0 to 1000.')
  })
})
