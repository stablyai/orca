import { describe, expect, it } from 'vitest'
import {
  decideStartupAutomaticWorkMode,
  type AutomaticWorkRunMarker
} from './automatic-work-run-marker'

const BOOT = { bootTimeMs: 1_000_000, bootId: null }

function marker(overrides: Partial<AutomaticWorkRunMarker> = {}): AutomaticWorkRunMarker {
  return { schemaVersion: 1, boot: BOOT, state: 'running', mode: { kind: 'normal' }, ...overrides }
}

describe('decideStartupAutomaticWorkMode', () => {
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
