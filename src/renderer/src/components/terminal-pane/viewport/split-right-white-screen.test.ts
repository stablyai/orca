import { describe, expect, it, vi } from 'vitest'
import {
  reconcilePtySizeAcrossFrames,
  type PtySizeReconcileDimensions,
  type PtySizeReconcileOptions
} from './pty-size-reconcile'

/** A split can spawn at 0×0 before layout is measurable; reconciliation must apply its measured grid or a visible-only 80×24 fallback before terminating to avoid a blank shell. */

function createFrameScheduler() {
  const queue = new Map<number, () => void>()
  let nextHandle = 1
  return {
    requestFrame: (callback: () => void): number => {
      const handle = nextHandle++
      queue.set(handle, callback)
      return handle
    },
    cancelFrame: (handle: number): void => {
      queue.delete(handle)
    },
    run(maxFrames = 5000): number {
      let ran = 0
      while (queue.size > 0 && ran < maxFrames) {
        const [handle, callback] = queue.entries().next().value as [number, () => void]
        queue.delete(handle)
        callback()
        ran += 1
      }
      return ran
    },
    pending: () => queue.size
  }
}

function runReconcile(
  overrides: Partial<PtySizeReconcileOptions> & Pick<PtySizeReconcileOptions, 'measure'>
): { resize: ReturnType<typeof vi.fn>; lastSent: PtySizeReconcileDimensions | null } {
  const scheduler = createFrameScheduler()
  const resize = vi.fn()
  let lastSent: PtySizeReconcileDimensions | null = null
  reconcilePtySizeAcrossFrames({
    // Spawn raced the reparented split’s layout and received 0×0.
    spawnCols: 0,
    spawnRows: 0,
    isAlive: () => true,
    isParked: () => false,
    isAuthoritative: () => true,
    resize: (cols, rows) => {
      lastSent = { cols, rows }
      resize(cols, rows)
    },
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    ...overrides
  })
  scheduler.run()
  return { resize, lastSent }
}

describe('split-right white screen: post-spawn PTY size reconcile', () => {
  it('recovers a 0x0 spawn whose container is briefly unmeasurable then settles', () => {
    // Layout arrives after several null measurements; reconciliation must move the PTY out of 0×0.
    let frame = 0
    const SETTLE_AT = 3
    const { resize, lastSent } = runReconcile({
      measure: vi.fn((): PtySizeReconcileDimensions | null => {
        const dims = frame < SETTLE_AT ? null : { cols: 120, rows: 40 }
        frame += 1
        return dims
      }),
      // Local PTY: applied size readback reflects what was actually forwarded.
      getAppliedSize: vi.fn(async () => lastSentForApplied)
    })

    expect(resize).toHaveBeenCalledWith(120, 40)
    expect(lastSent).toEqual({ cols: 120, rows: 40 })
  })

  it('forwards a safe fallback grid when a visible pane stays unmeasurable (never leaves the PTY at 0x0)', () => {
    // Model a visible split that stays unmeasurable for the entire reconciliation window.
    const measure = vi.fn((): PtySizeReconcileDimensions | null => null)
    const { resize, lastSent } = runReconcile({
      measure,
      getAppliedSize: vi.fn(async () => ({ cols: 0, rows: 0 }))
    })

    expect(measure.mock.calls.length).toBeGreaterThan(0)

    // Visible 0×0 PTYs need a fallback before termination; live onResize supplies the eventual grid.
    expect(lastSent, 'reconcile must not leave a split-right PTY pinned at 0x0').not.toBeNull()
    expect(resize).toHaveBeenCalled()
    const [cols, rows] = resize.mock.calls.at(-1) ?? [0, 0]
    expect(cols, 'PTY columns must be non-zero or the shell renders blank').toBeGreaterThan(0)
    expect(rows, 'PTY rows must be non-zero or the shell renders blank').toBeGreaterThan(0)
  })

  it('does NOT force a fallback when the pane is hidden (background spawn legitimately stays 0x0)', () => {
    // Hidden orchestration spawns may legitimately stay 0×0 until reveal; do not impose a phantom grid.
    const { resize, lastSent } = runReconcile({
      isAuthoritative: () => false,
      measure: vi.fn((): PtySizeReconcileDimensions | null => null),
      getAppliedSize: vi.fn(async () => ({ cols: 0, rows: 0 }))
    })

    expect(resize).not.toHaveBeenCalled()
    expect(lastSent).toBeNull()
  })
})

const lastSentForApplied: PtySizeReconcileDimensions = { cols: 120, rows: 40 }
