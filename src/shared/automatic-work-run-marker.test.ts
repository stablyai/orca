import { describe, expect, it } from 'vitest'
import {
  decideStartupAutomaticWorkMode,
  isSameBoot,
  parseAutomaticWorkRunMarker,
  type AutomaticWorkRunMarker
} from './automatic-work-run-marker'

const BOOT = { bootTimeMs: 1_000_000, bootId: null }

function marker(overrides: Partial<AutomaticWorkRunMarker> = {}): AutomaticWorkRunMarker {
  return { schemaVersion: 1, boot: BOOT, state: 'running', mode: { kind: 'normal' }, ...overrides }
}

describe('decideStartupAutomaticWorkMode', () => {
  it('pauses only after a death with automatic work running during the same boot', () => {
    expect(decideStartupAutomaticWorkMode(marker(), BOOT, 5)).toEqual({
      kind: 'paused',
      reason: 'unclean_host_death',
      since: 5
    })
    expect(decideStartupAutomaticWorkMode(marker({ state: 'clean-exit' }), BOOT, 5)).toEqual({
      kind: 'normal'
    })
    expect(decideStartupAutomaticWorkMode(null, BOOT, 5)).toEqual({ kind: 'normal' })
  })

  it('lets a new boot through the normal budget instead of pausing', () => {
    expect(
      decideStartupAutomaticWorkMode(
        marker(),
        { bootTimeMs: BOOT.bootTimeMs + 3_600_000, bootId: null },
        5
      )
    ).toEqual({ kind: 'normal' })
    expect(
      decideStartupAutomaticWorkMode(
        marker({ boot: { bootTimeMs: 0, bootId: 'a' } }),
        { bootTimeMs: 0, bootId: 'b' },
        5
      )
    ).toEqual({ kind: 'normal' })
  })

  it('keeps a recorded pause until an explicit resume, across boots', () => {
    const paused = { kind: 'paused' as const, reason: 'unclean_host_death' as const, since: 1 }
    expect(
      decideStartupAutomaticWorkMode(
        marker({ state: 'clean-exit', mode: paused }),
        { bootTimeMs: 9e12, bootId: null },
        5
      )
    ).toEqual(paused)
  })
})

describe('isSameBoot', () => {
  it('prefers an exact boot id and tolerates wall-clock drift otherwise', () => {
    expect(isSameBoot({ bootTimeMs: 0, bootId: 'x' }, { bootTimeMs: 9e9, bootId: 'x' })).toBe(true)
    expect(isSameBoot({ bootTimeMs: 0, bootId: null }, { bootTimeMs: 60_000, bootId: null })).toBe(
      true
    )
    expect(isSameBoot({ bootTimeMs: 0, bootId: null }, { bootTimeMs: 600_000, bootId: null })).toBe(
      false
    )
    // Windows: boot time cannot identify a boot, so it never reads as the same one.
    expect(isSameBoot({ bootTimeMs: null, bootId: null }, { bootTimeMs: null, bootId: null })).toBe(
      false
    )
  })
})

describe('parseAutomaticWorkRunMarker', () => {
  it('round-trips a marker and reads foreign content as no previous run', () => {
    expect(parseAutomaticWorkRunMarker(JSON.stringify(marker()))).toEqual(marker())
    expect(parseAutomaticWorkRunMarker('not json')).toBeNull()
    expect(
      parseAutomaticWorkRunMarker(JSON.stringify({ ...marker(), schemaVersion: 2 }))
    ).toBeNull()
    expect(
      parseAutomaticWorkRunMarker(JSON.stringify({ ...marker(), mode: { kind: 'paused' } }))
    ).toBeNull()
  })
})
