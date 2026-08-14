import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectRendererMemoryProfileCounts } from '@/lib/renderer-memory-profile'
import { registerPtySideEffectPendingGauge } from './pty-side-effect-pending-census'

function ptySideEffectCounts(): { pending: number; retained: number; processors: number } {
  const counts = collectRendererMemoryProfileCounts()
  return {
    pending: counts['ptySideEffects.pending'],
    retained: counts['ptySideEffects.retained'],
    processors: counts['ptySideEffects.processors']
  }
}

function fixedGauge(pending: number, retained = pending): { dispose: () => void } {
  // Why the local: the census holds gauges weakly, so a test gauge needs a strong owner too.
  const gauge = { pending: () => pending, retained: () => retained }
  return { dispose: registerPtySideEffectPendingGauge(gauge) }
}

describe('pty side-effect pending census', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sums registered gauges and drops disposed ones', () => {
    const before = ptySideEffectCounts()
    const a = fixedGauge(3, 5)
    const b = fixedGauge(4, 4)

    let counts = ptySideEffectCounts()
    expect(counts.pending).toBe(before.pending + 7)
    expect(counts.retained).toBe(before.retained + 9)
    expect(counts.processors).toBe(before.processors + 2)

    a.dispose()
    counts = ptySideEffectCounts()
    expect(counts.pending).toBe(before.pending + 4)
    expect(counts.retained).toBe(before.retained + 4)
    expect(counts.processors).toBe(before.processors + 1)

    b.dispose()
    expect(ptySideEffectCounts()).toEqual(before)
  })

  it('ignores a repeated dispose instead of dropping another gauge', () => {
    const before = ptySideEffectCounts()
    const a = fixedGauge(3)
    const b = fixedGauge(4)

    a.dispose()
    a.dispose()

    expect(ptySideEffectCounts().processors).toBe(before.processors + 1)
    b.dispose()
    expect(ptySideEffectCounts()).toEqual(before)
  })

  it('stops tracking new gauges past the cap so a missed dispose cannot grow it', () => {
    const before = ptySideEffectCounts()
    const owners = Array.from({ length: 600 }, () => fixedGauge(1))
    try {
      expect(ptySideEffectCounts().processors).toBe(512)
    } finally {
      for (const owner of owners) {
        owner.dispose()
      }
    }
    expect(ptySideEffectCounts()).toEqual(before)
  })

  it('tracks a live output processor queue through enqueue, drain, and dispose', async () => {
    vi.useFakeTimers()
    const { createPtyOutputProcessor } = await import('./pty-transport')
    const before = ptySideEffectCounts()
    const processor = createPtyOutputProcessor({ onTitleChange: vi.fn() })

    expect(ptySideEffectCounts()).toEqual({
      pending: before.pending,
      retained: before.retained,
      processors: before.processors + 1
    })

    processor.processData('\x1b]0;census-title\x07', { onData: vi.fn() })
    expect(ptySideEffectCounts().pending).toBe(before.pending + 1)

    await vi.runOnlyPendingTimersAsync()
    expect(ptySideEffectCounts().pending).toBe(before.pending)

    processor.processData('\x1b]0;census-title-2\x07', { onData: vi.fn() })
    expect(ptySideEffectCounts().pending).toBe(before.pending + 1)
    processor.clearAccumulatedState()
    expect(ptySideEffectCounts().pending).toBe(before.pending)

    processor.disposePendingSideEffectGauge()
    expect(ptySideEffectCounts()).toEqual(before)
  })

  // Why: a partly drained queue still holds every entry until compaction, so depth alone
  // would understate the retained bytes this census exists to attribute.
  it('reports drained-but-uncompacted entries as retained after a bounded drain', async () => {
    vi.useFakeTimers()
    const { createPtyOutputProcessor } = await import('./pty-transport')
    const before = ptySideEffectCounts()
    const processor = createPtyOutputProcessor({ onTitleChange: vi.fn() })

    for (let i = 0; i < 100; i += 1) {
      processor.processData(`\x1b]0;census-title-${i}\x07`, { onData: vi.fn() })
    }
    expect(ptySideEffectCounts()).toEqual({
      pending: before.pending + 100,
      retained: before.retained + 100,
      processors: before.processors + 1
    })

    // One drain applies MAX_PTY_SIDE_EFFECTS_PER_DRAIN entries but stays under the compaction threshold.
    await vi.runOnlyPendingTimersAsync()
    expect(ptySideEffectCounts().pending).toBe(before.pending + 36)
    expect(ptySideEffectCounts().retained).toBe(before.retained + 100)

    processor.flushPendingSideEffects()
    expect(ptySideEffectCounts()).toEqual({
      pending: before.pending,
      retained: before.retained,
      processors: before.processors + 1
    })

    processor.disposePendingSideEffectGauge()
    expect(ptySideEffectCounts()).toEqual(before)
  })
})
