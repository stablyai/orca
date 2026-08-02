import { describe, expect, it, vi } from 'vitest'
import {
  reconcilePtySizeAcrossFrames,
  type PtySizeReconcileDimensions,
  type PtySizeReconcileOptions
} from './pty-size-reconcile'

/**
 * Regression: "Split terminal right" → new pane shows a white/blank screen.
 *
 * Spawn path (pty-connection.ts runDeferredConnect):
 *   - A split pane's PTY spawn is deferred to a requestAnimationFrame.
 *   - That frame calls safeFit(pane) then reads pane.terminal.cols/rows and
 *     spawns with transport.connect({ cols, rows }).
 *   - For a freshly reparented split-right pane whose container has not laid
 *     out yet, safeFit is a no-op (canMeasurePaneForFit / getProposedDimensions
 *     yields nothing), so cols === rows === 0 and the PTY is spawned at 0x0.
 *
 * The post-spawn reconcile (reconcilePtySizeAfterSpawn -> this loop) is the
 * ONLY thing that can heal a 0x0 spawn. Its measure() returns null whenever the
 * pane is still unmeasurable (the `cols > 0 && rows > 0 ? ... : null` gate).
 * Before the fix, null frames made no stability progress AND forwarded nothing,
 * so a pane that stayed unmeasurable through the authoritative window ran to the
 * hard frame cap and terminated having forwarded NO resize — leaving the PTY
 * pinned at 0x0. A shell rendering into a 0-row grid is the blank/white pane the
 * user reported.
 *
 * The fix forwards a safe 80×24 fallback on termination when a VISIBLE pane is
 * still pinned at 0x0, so the shell always has a usable grid; the live onResize
 * re-syncs the true size once the pane lays out. These tests pin both the
 * normal settle and the fallback.
 *
 * Harness mirrors pty-size-reconcile.test.ts (deterministic frame scheduler).
 */

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
    // The freshly split pane was spawned at 0x0 (deferred fit ran before the
    // reparented container had layout dimensions).
    spawnCols: 0,
    spawnRows: 0,
    isAlive: () => true,
    isParked: () => false,
    // Pane is visible (the user just split the active tab to the right), so the
    // renderer resize path is "authoritative" immediately.
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
    // Real-world timeline for split-right: the reparented pane has no layout for
    // the first handful of frames (measure -> null), then the split equalizes
    // and the pane measures a real grid. The reconcile must forward that grid so
    // the PTY leaves 0x0; otherwise the shell renders into a 0-row buffer (blank).
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

    // The settled 120x40 grid is forwarded so the PTY leaves its 0x0 spawn size.
    expect(resize).toHaveBeenCalledWith(120, 40)
    expect(lastSent).toEqual({ cols: 120, rows: 40 })
  })

  it('forwards a safe fallback grid when a visible pane stays unmeasurable (never leaves the PTY at 0x0)', () => {
    // The reparented split-right pane never becomes measurable within the
    // reconcile window (0-size container: the documented split-mount race where
    // layout has not settled). measure() returns null on every frame.
    const measure = vi.fn((): PtySizeReconcileDimensions | null => null)
    const { resize, lastSent } = runReconcile({
      measure,
      getAppliedSize: vi.fn(async () => ({ cols: 0, rows: 0 }))
    })

    // The loop ran its full course (hard cap) but never measured a grid.
    expect(measure.mock.calls.length).toBeGreaterThan(0)

    // The PTY was spawned at 0x0 and the reconcile is the only corrector. With
    // the fix, on termination a still-0x0 VISIBLE pane is given a safe default
    // grid so the shell never renders into a 0-row buffer (the white screen);
    // the live onResize re-syncs the true size once the pane lays out.
    expect(lastSent, 'reconcile must not leave a split-right PTY pinned at 0x0').not.toBeNull()
    expect(resize).toHaveBeenCalled()
    const [cols, rows] = resize.mock.calls.at(-1) ?? [0, 0]
    expect(cols, 'PTY columns must be non-zero or the shell renders blank').toBeGreaterThan(0)
    expect(rows, 'PTY rows must be non-zero or the shell renders blank').toBeGreaterThan(0)
  })

  it('does NOT force a fallback when the pane is hidden (background spawn legitimately stays 0x0)', () => {
    // A permanently-hidden background spawn at 0x0 is legitimate (orchestration
    // workers, `terminal create` without --focus); it refits when shown, so the
    // reconcile must not push a phantom 80x24 onto it.
    const { resize, lastSent } = runReconcile({
      isAuthoritative: () => false,
      measure: vi.fn((): PtySizeReconcileDimensions | null => null),
      getAppliedSize: vi.fn(async () => ({ cols: 0, rows: 0 }))
    })

    expect(resize).not.toHaveBeenCalled()
    expect(lastSent).toBeNull()
  })
})

// Stand-in for a local PTY's applied-size readback used by the first test.
const lastSentForApplied: PtySizeReconcileDimensions = { cols: 120, rows: 40 }
