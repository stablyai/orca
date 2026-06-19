import { afterEach, describe, expect, it } from 'vitest'
import { hydrateOverrides, onOverrideChange, setFitOverride } from './mobile-fit-overrides'

afterEach(() => {
  hydrateOverrides([])
})

describe('hydrateOverrides notifications', () => {
  it('notifies listeners for hydrated and cleared overrides', () => {
    setFitOverride('pty-old', 'mobile-fit', 49, 20)
    const events: { ptyId: string; mode: string; priorCols: number | null }[] = []
    const unsub = onOverrideChange((event) => {
      events.push({ ptyId: event.ptyId, mode: event.mode, priorCols: event.priorCols })
    })

    hydrateOverrides([{ ptyId: 'pty-new', mode: 'mobile-fit', cols: 80, rows: 30 }])

    expect(events).toEqual([
      { ptyId: 'pty-new', mode: 'mobile-fit', priorCols: null },
      { ptyId: 'pty-old', mode: 'desktop-fit', priorCols: 49 }
    ])

    unsub()
  })
})
