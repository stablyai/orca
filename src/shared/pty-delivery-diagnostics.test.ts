// Why: pins the freeze-report primitives — the breadcrumb ring must stay
// bounded and coalesce repeat events (a flood costs one slot per second, not
// unbounded memory), and pty-id redaction must keep the correlatable suffix
// while dropping the path-bearing worktree prefix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPtyDeliveryBreadcrumbRing,
  redactPtyIdForDiagnostics
} from './pty-delivery-diagnostics'

describe('pty delivery breadcrumb ring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces same-kind events inside the window and separates them outside it', () => {
    const ring = createPtyDeliveryBreadcrumbRing(10, 1_000)
    ring.record('gate-mark', { id: 'a' })
    vi.advanceTimersByTime(200)
    ring.record('gate-mark', { id: 'b' })
    vi.advanceTimersByTime(200)
    ring.record('gate-mark')

    let entries = ring.snapshot()
    expect(entries).toHaveLength(1)
    expect(entries[0].repeats).toBe(3)
    // The freshest detail wins so the report shows the latest actor.
    expect(entries[0].detail).toEqual({ id: 'b' })

    vi.advanceTimersByTime(2_000)
    ring.record('gate-mark', { id: 'c' })
    entries = ring.snapshot()
    expect(entries).toHaveLength(2)
    expect(entries[1].repeats).toBeUndefined()
  })

  it('does not coalesce across different kinds and stays bounded at capacity', () => {
    const ring = createPtyDeliveryBreadcrumbRing(5, 1_000)
    ring.record('gate-mark')
    ring.record('gate-unmark')
    expect(ring.snapshot()).toHaveLength(2)

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(2_000)
      ring.record(`kind-${i}`)
    }
    const entries = ring.snapshot()
    expect(entries).toHaveLength(5)
    expect(entries[4].kind).toBe('kind-19')
  })

  it('snapshot returns copies and reset empties the ring', () => {
    const ring = createPtyDeliveryBreadcrumbRing(5, 1_000)
    ring.record('watchdog-heal', { healCount: 1 })
    const entries = ring.snapshot()
    entries[0].kind = 'tampered'
    expect(ring.snapshot()[0].kind).toBe('watchdog-heal')
    ring.reset()
    expect(ring.snapshot()).toHaveLength(0)
  })
})

describe('redactPtyIdForDiagnostics', () => {
  it('keeps the @@ suffix and drops the path-bearing worktree prefix', () => {
    expect(redactPtyIdForDiagnostics('/Users/someone/repo@@ab12cd34')).toBe('…@@ab12cd34')
  })

  it('truncates long ids without a separator and passes short ids through', () => {
    expect(redactPtyIdForDiagnostics('pty-1')).toBe('pty-1')
    const long = 'x'.repeat(40)
    expect(redactPtyIdForDiagnostics(long)).toBe(`…${'x'.repeat(12)}`)
  })
})
