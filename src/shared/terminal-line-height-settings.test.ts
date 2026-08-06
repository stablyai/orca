import { describe, expect, it } from 'vitest'
import {
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  normalizeTerminalLineHeight
} from './terminal-line-height-settings'

describe('normalizeTerminalLineHeight', () => {
  it.each([
    [undefined, MIN_TERMINAL_LINE_HEIGHT],
    [Number.NaN, MIN_TERMINAL_LINE_HEIGHT],
    [0.85, MIN_TERMINAL_LINE_HEIGHT],
    [1, 1],
    [1.35, 1.35],
    [3, 3],
    [4, MAX_TERMINAL_LINE_HEIGHT]
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeTerminalLineHeight(input)).toBe(expected)
  })
})
