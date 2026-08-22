import { describe, expect, it } from 'vitest'
import { dotnetTicksToUnixMs, parsePsElapsedTimeToSeconds } from './ps-elapsed-time'

describe('parsePsElapsedTimeToSeconds', () => {
  it('parses seconds-only mm:ss', () => {
    expect(parsePsElapsedTimeToSeconds('00:05')).toBe(5)
    expect(parsePsElapsedTimeToSeconds('12:34')).toBe(12 * 60 + 34)
  })

  it('parses hh:mm:ss', () => {
    expect(parsePsElapsedTimeToSeconds('1:02:03')).toBe(1 * 3_600 + 2 * 60 + 3)
  })

  it('parses dd-hh:mm:ss', () => {
    expect(parsePsElapsedTimeToSeconds('2-03:04:05')).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)
  })

  it('rejects malformed input', () => {
    expect(parsePsElapsedTimeToSeconds('')).toBeUndefined()
    expect(parsePsElapsedTimeToSeconds('not-a-time')).toBeUndefined()
    expect(parsePsElapsedTimeToSeconds('5')).toBeUndefined()
  })
})

describe('dotnetTicksToUnixMs', () => {
  it('round-trips a Unix timestamp through the .NET epoch offset', () => {
    // Why: the offset itself is the fact under test — deriving ticks from a
    // known Unix ms (rather than a hand-computed literal) can't silently
    // encode the same arithmetic mistake on both sides.
    const DOTNET_TICKS_UNIX_EPOCH_OFFSET = 621_355_968_000_000_000n
    const unixMs = Date.parse('2024-01-01T00:00:00.000Z')
    const ticks = DOTNET_TICKS_UNIX_EPOCH_OFFSET + BigInt(unixMs) * 10_000n
    expect(dotnetTicksToUnixMs(ticks)).toBe(unixMs)
  })

  it('returns 0 for ticks at the Unix epoch', () => {
    const DOTNET_TICKS_UNIX_EPOCH_OFFSET = 621_355_968_000_000_000n
    expect(dotnetTicksToUnixMs(DOTNET_TICKS_UNIX_EPOCH_OFFSET)).toBe(0)
  })
})
