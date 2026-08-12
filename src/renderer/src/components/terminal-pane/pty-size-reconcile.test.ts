import { describe, expect, it, vi } from 'vitest'
import {
  reconcilePtySizeAcrossFrames,
  type PtySizeReconcileDimensions,
  type PtySizeReconcileOptions
} from './pty-size-reconcile'

/**
 * Reproduction harness for the terminal column-desync bug: the PTY spawns wide and the split/sidebar
 * narrows the pane frames later, so the fix must converge to the settled narrow width whenever the
 * layout lands (the prior fixed 12-frame budget expired early), watching while hidden until authoritative.
 */

/** A deterministic frame scheduler: callbacks queue, then run() drains them. */
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
    /** Run up to `maxFrames` queued frames, one per tick. Returns frames run. */
    run(maxFrames = 1000): number {
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

/** A pane whose measured grid follows a frame-indexed timeline; `measure()` is called once per reconcile frame, so call count = frames elapsed. */
function createTimelinePane(timeline: (frame: number) => PtySizeReconcileDimensions | null) {
  let frame = 0
  return {
    measure: vi.fn((): PtySizeReconcileDimensions | null => {
      const dims = timeline(frame)
      frame += 1
      return dims
    })
  }
}

function runReconcile(
  overrides: Partial<PtySizeReconcileOptions> & Pick<PtySizeReconcileOptions, 'measure'>,
  maxFrames = 1000
): { resize: ReturnType<typeof vi.fn>; framesRun: number } {
  const scheduler = createFrameScheduler()
  const resize = vi.fn()
  reconcilePtySizeAcrossFrames({
    spawnCols: 203,
    spawnRows: 50,
    isAlive: () => true,
    isParked: () => false,
    // Default visible; specific tests override to model the hidden mount window where onResize is dropped.
    isAuthoritative: () => true,
    resize,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    ...overrides
  })
  const framesRun = scheduler.run(maxFrames)
  return { resize, framesRun }
}

describe('reconcilePtySizeAcrossFrames', () => {
  it('forwards a narrow settle that lands AFTER a fixed 12-frame budget — while hidden', () => {
    // Golden repro: hidden pane spawned wide, narrows at frame 15 — a 12-frame budget stops still-wide; the convergent loop keeps watching.
    const NARROW_AT = 15
    const pane = createTimelinePane((frame) =>
      frame < NARROW_AT ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 }
    )
    const { resize } = runReconcile({ measure: pane.measure, isAuthoritative: () => false })

    expect(resize).toHaveBeenCalled()
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('forwards a narrow settle that lands LATE while hidden — no fixed frame floor', () => {
    // A fixed MIN-frames floor would falsely settle on the wide spawn before a late narrowing lands — watch until authoritative or the cap.
    const NARROW_AT = 40
    const pane = createTimelinePane((frame) =>
      frame < NARROW_AT ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 }
    )
    const { resize } = runReconcile({ measure: pane.measure, isAuthoritative: () => false })

    expect(resize).toHaveBeenCalled()
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('forwards a late settle that lands just before the pane becomes authoritative', () => {
    // Forwards the narrow width while hidden (resize bypasses the visibility gate), then stops once authoritative+stable.
    const NARROW_AT = 40
    const AUTHORITATIVE_AT = 45
    let frameSeen = 0
    const pane = createTimelinePane((frame) => {
      frameSeen = frame
      return frame < NARROW_AT ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 }
    })
    const { resize } = runReconcile({
      measure: pane.measure,
      isAuthoritative: () => frameSeen >= AUTHORITATIVE_AT
    })

    expect(resize).toHaveBeenCalled()
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('hands off after the pane is visible+stable, leaving later reflows to the live onResize', () => {
    // Once authoritative + stable, onResize owns further reflow, so the reconcile stops here (later splits hit that backstop).
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const { resize, framesRun } = runReconcile({ measure: pane.measure })
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith(79, 50)
    // Frame 1 forwards the change; frames 2..9 stable → settles at SETTLE_FRAMES(8), i.e. 9 total (far short of the 180 cap).
    expect(framesRun).toBe(9)
  })

  it('keeps polling through unmeasurable frames (pane has no layout yet)', () => {
    // A fresh split mount can be unmeasurable for many frames — those frames must NOT count as "settled".
    const NARROW_AT = 20
    const pane = createTimelinePane((frame) => (frame < NARROW_AT ? null : { cols: 80, rows: 24 }))
    const { resize } = runReconcile({ measure: pane.measure })

    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith(80, 24)
  })

  it('hands off (stops) once authoritative and the grid has been stable', () => {
    // Once visible and stable, the live onResize owns future corrections, so the reconcile stops (no polling to the cap).
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const { framesRun } = runReconcile({ measure: pane.measure })
    // Should settle a few frames after the single resize, well short of the cap.
    expect(framesRun).toBeGreaterThan(0)
    expect(framesRun).toBeLessThan(180)
  })

  it('does NOT hand off while hidden — keeps watching until the hard cap', () => {
    // While never authoritative, a stable grid is no safe stop (onResize can't back us up), so it runs to the hard cap.
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const { framesRun } = runReconcile({
      measure: pane.measure,
      isAuthoritative: () => false
    })
    expect(framesRun).toBe(180)
  })

  it('forwards no resize when the settled size never changes from spawn dims', () => {
    // If xterm already matches the spawn width the whole time, no SIGWINCH at all.
    const pane = createTimelinePane(() => ({ cols: 203, rows: 50 }))
    const { resize } = runReconcile({ measure: pane.measure })
    expect(resize).not.toHaveBeenCalled()
  })

  it('does not loop forever — terminates within the hard frame cap', () => {
    // Pane that never stabilizes (oscillates) must still hit the hard cap.
    const pane = createTimelinePane((frame) =>
      frame % 2 === 0 ? { cols: 100, rows: 30 } : { cols: 101, rows: 30 }
    )
    const { framesRun } = runReconcile({ measure: pane.measure }, 10_000)
    expect(framesRun).toBe(180)
  })

  it('issues only a couple of SIGWINCH for a monotonic narrow settle (not one per frame)', () => {
    // 203 → 120 → 79 then stable — the TUI should see a small, bounded number of size changes during startup.
    const pane = createTimelinePane((frame) => {
      if (frame < 5) {
        return { cols: 203, rows: 50 }
      }
      if (frame < 10) {
        return { cols: 120, rows: 50 }
      }
      return { cols: 79, rows: 50 }
    })
    const { resize } = runReconcile({ measure: pane.measure })
    expect(resize.mock.calls.length).toBeLessThanOrEqual(3)
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('skips parked (mobile-fit) frames without forwarding a desktop resize', () => {
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const { resize, framesRun } = runReconcile({
      measure: pane.measure,
      isParked: () => true
    })
    expect(resize).not.toHaveBeenCalled()
    expect(pane.measure).not.toHaveBeenCalled()
    // Parked frames still count toward the cap so a parked PTY can't loop forever.
    expect(framesRun).toBe(180)
  })

  it('resumes and converges after a transient park (mobile take-back during mount)', () => {
    // Parked frames are SKIPPED, not cancelled — after a transient mobile take-over the reconcile must resume, not abort.
    const PARKED_UNTIL = 10
    let frameSeen = 0
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const scheduler = createFrameScheduler()
    const resize = vi.fn()
    reconcilePtySizeAcrossFrames({
      spawnCols: 203,
      spawnRows: 50,
      isAlive: () => true,
      isParked: () => frameSeen++ < PARKED_UNTIL,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame
    })
    scheduler.run()
    // While parked, measure()/resize() are skipped; after take-back the desktop width is forwarded exactly once.
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('stops promptly once cancelled (pane disposed mid-reconcile)', () => {
    const scheduler = createFrameScheduler()
    const resize = vi.fn()
    const pane = createTimelinePane((frame) =>
      frame < 30 ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 }
    )
    const handle = reconcilePtySizeAcrossFrames({
      spawnCols: 203,
      spawnRows: 50,
      isAlive: () => true,
      isParked: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame
    })
    // Run a few frames, then cancel — no further frames should be scheduled.
    scheduler.run(3)
    handle.cancel()
    expect(scheduler.pending()).toBe(0)
    const measuredBefore = pane.measure.mock.calls.length
    scheduler.run(100)
    expect(pane.measure.mock.calls.length).toBe(measuredBefore)
  })

  it('stops when the PTY is no longer alive (rebound / disposed)', () => {
    const scheduler = createFrameScheduler()
    const resize = vi.fn()
    let alive = true
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    reconcilePtySizeAcrossFrames({
      spawnCols: 203,
      spawnRows: 50,
      isAlive: () => alive,
      isParked: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame
    })
    scheduler.run(2)
    const callsBefore = resize.mock.calls.length
    alive = false
    scheduler.run(100)
    expect(resize.mock.calls.length).toBe(callsBefore)
    expect(scheduler.pending()).toBe(0)
  })

  // Why: resize is fire-and-forget for daemon/SSH PTYs, so a stable grid can hide a dropped size; getAppliedSize confirms before handoff.
  describe('applied-size verification before handoff', () => {
    /** Drain frames, flushing microtasks between each so async getAppliedSize promises resolve before the next frame. */
    async function runAsync(
      scheduler: ReturnType<typeof createFrameScheduler>,
      maxFrames = 1000
    ): Promise<void> {
      let ran = 0
      while (scheduler.pending() > 0 && ran < maxFrames) {
        scheduler.run(1)
        ran += 1
        // Let any getAppliedSize().then(...) settle before the next frame.
        await Promise.resolve()
        await Promise.resolve()
      }
    }

    it('keeps converging when the PTY drops the resize (applied stays wide)', async () => {
      const scheduler = createFrameScheduler()
      const resize = vi.fn()
      // xterm settles narrow, but the PTY never applies it — every applied-size read reports the stale wide spawn width.
      const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
      reconcilePtySizeAcrossFrames({
        spawnCols: 203,
        spawnRows: 50,
        isAlive: () => true,
        isParked: () => false,
        isAuthoritative: () => true,
        measure: pane.measure,
        resize,
        getAppliedSize: async () => ({ cols: 203, rows: 50 }),
        requestFrame: scheduler.requestFrame,
        cancelFrame: scheduler.cancelFrame
      })
      await runAsync(scheduler, 400)

      // Must re-forward the narrow size more than once (verify-driven), never falsely handing off on a dropped size.
      const narrowForwards = resize.mock.calls.filter((c) => c[0] === 79 && c[1] === 50)
      expect(narrowForwards.length).toBeGreaterThan(1)
    })

    it('hands off once the applied size matches the forwarded grid', async () => {
      const scheduler = createFrameScheduler()
      const resize = vi.fn()
      const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
      let applied = { cols: 203, rows: 50 }
      // The PTY applies the narrow size after the first corrective forward.
      reconcilePtySizeAcrossFrames({
        spawnCols: 203,
        spawnRows: 50,
        isAlive: () => true,
        isParked: () => false,
        isAuthoritative: () => true,
        measure: pane.measure,
        resize: vi.fn((cols, rows) => {
          resize(cols, rows)
          applied = { cols, rows }
        }),
        getAppliedSize: async () => applied,
        requestFrame: scheduler.requestFrame,
        cancelFrame: scheduler.cancelFrame
      })
      await runAsync(scheduler, 400)

      // It converges and then STOPS (no pending frames) well before the hard cap.
      expect(resize).toHaveBeenLastCalledWith(79, 50)
      expect(scheduler.pending()).toBe(0)
    })

    it('hands off when applied size cannot be confirmed (null read)', async () => {
      const scheduler = createFrameScheduler()
      const resize = vi.fn()
      const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
      reconcilePtySizeAcrossFrames({
        spawnCols: 203,
        spawnRows: 50,
        isAlive: () => true,
        isParked: () => false,
        isAuthoritative: () => true,
        measure: pane.measure,
        resize,
        // A provider that cannot confirm applied size must not wedge the loop.
        getAppliedSize: async () => null,
        requestFrame: scheduler.requestFrame,
        cancelFrame: scheduler.cancelFrame
      })
      await runAsync(scheduler, 400)
      expect(scheduler.pending()).toBe(0)
    })

    it('does not verify or re-forward while parked — mobile drives at phone dims', async () => {
      const scheduler = createFrameScheduler()
      const resize = vi.fn()
      // Parked gate must suppress the verify entirely — mobile sits at phone dims, so any re-forward would be dropped.
      const getAppliedSize = vi.fn(async () => ({ cols: 40, rows: 30 }))
      const pane = createTimelinePane(() => ({ cols: 120, rows: 40 }))
      reconcilePtySizeAcrossFrames({
        spawnCols: 120,
        spawnRows: 40,
        isAlive: () => true,
        isParked: () => true,
        isAuthoritative: () => true,
        measure: pane.measure,
        resize,
        getAppliedSize,
        requestFrame: scheduler.requestFrame,
        cancelFrame: scheduler.cancelFrame
      })
      await runAsync(scheduler, 400)
      expect(getAppliedSize).not.toHaveBeenCalled()
      expect(resize).not.toHaveBeenCalled()
    })

    it('does NOT re-forward when a mobile-fit override parks the PTY mid-verification', async () => {
      const scheduler = createFrameScheduler()
      // Race: PTY parks after the read is issued but before it resolves; resolution must re-check parked (visibility-resume mobile-fit leak regression).
      let parked = false
      const resize = vi.fn()
      const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
      reconcilePtySizeAcrossFrames({
        spawnCols: 203,
        spawnRows: 50,
        isAlive: () => true,
        isParked: () => parked,
        isAuthoritative: () => true,
        measure: pane.measure,
        resize,
        // Stale wide applied size — a parked-blind loop would re-forward the narrow desktop grid on resolution.
        getAppliedSize: async () => {
          // Park the PTY while this read is in flight.
          parked = true
          return { cols: 203, rows: 50 }
        },
        requestFrame: scheduler.requestFrame,
        cancelFrame: scheduler.cancelFrame
      })
      await runAsync(scheduler, 400)

      // Only the pre-park settle forward is allowed; the verify-driven re-forward must be suppressed once the override parks the PTY.
      const narrowForwards = resize.mock.calls.filter((c) => c[0] === 79 && c[1] === 50)
      expect(narrowForwards.length).toBeLessThanOrEqual(1)
    })
  })
})
