import { describe, expect, it } from 'vitest'
import { normalizeTerminalScrollbarWidth } from './terminal-scroll-settings'

describe('normalizeTerminalScrollbarWidth', () => {
  it.each([
    [undefined, 7],
    [Number.NaN, 7],
    [Number.POSITIVE_INFINITY, 7],
    [0, 7],
    [3, 7],
    [500, 20],
    [12.4, 12],
    [12.6, 13]
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeTerminalScrollbarWidth(input)).toBe(expected)
  })
})
