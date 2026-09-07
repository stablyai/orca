import { describe, expect, it } from 'vitest'
import { HermesRunRefRetainer } from './hermes-run-ref-retention'

describe('HermesRunRefRetainer', () => {
  it('preserves every ref and exact order below the limit', () => {
    const retainer = new HermesRunRefRetainer<{ id: string; run_at: string }>(3)
    retainer.add({ id: 'middle', run_at: '2026-05-15T09:00:00Z' })
    retainer.add({ id: 'newest', run_at: '2026-05-16T09:00:00Z' })
    retainer.add({ id: 'oldest', run_at: '2026-05-14T09:00:00Z' })

    expect(retainer.finish()).toEqual({
      refs: [
        { id: 'newest', run_at: '2026-05-16T09:00:00Z' },
        { id: 'middle', run_at: '2026-05-15T09:00:00Z' },
        { id: 'oldest', run_at: '2026-05-14T09:00:00Z' }
      ],
      saturated: false
    })
  })

  it('retains the exact newest window and reports saturation', () => {
    const retainer = new HermesRunRefRetainer<{ id: string; run_at: string }>(3)
    for (const day of [1, 5, 2, 6, 3, 4]) {
      retainer.add({ id: `day-${day}`, run_at: `2026-05-0${day}T09:00:00Z` })
    }

    expect(retainer.finish()).toEqual({
      refs: [
        { id: 'day-6', run_at: '2026-05-06T09:00:00Z' },
        { id: 'day-5', run_at: '2026-05-05T09:00:00Z' },
        { id: 'day-4', run_at: '2026-05-04T09:00:00Z' }
      ],
      saturated: true
    })
  })
})
