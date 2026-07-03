import { describe, expect, it, vi } from 'vitest'
import {
  reconcilePtySizeAcrossFrames,
  type PtySizeReconcileDimensions,
  type PtySizeReconcileOptions
} from './pty-size-reconcile'

/**
 * Reproduction harness for the terminal column-desync bug (Slack: Claude Code
 * renders garbled when a new worktree is opened with the side split panel on).
 *
 * The PTY is spawned at the wide window width, then the split/sidebar layout
 * narrows the pane some frames LATER. The fix must converge the PTY to the
 * settled narrow width regardless of WHEN the layout lands — including a settle
 * that arrives well after any fixed frame budget (the prior fix used a fixed
 * 12-frame budget that expired before the split equalized). The reconcile keeps
 * polling while the pane is not yet authoritative (the hidden mount window where
 * the live onResize is dropped) and hands off once authoritative + stable.
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

/**
 * A pane whose measured grid follows a timeline keyed by frame index: it starts
 * unmeasurable (null) or wide, then narrows at some frame. `measure()` is called
 * once per reconcile frame, so the call count tracks frames elapsed.
 */
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
    // Default: pane is visible (the common case). Specific tests override this
    // to model the hidden mount window where the live onResize is dropped.
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
    // Golden repro: the pane mounts hidden (onResize dropped — the desync
    // window), spawned wide (203), still measuring wide for the first 15 frames
    // (split equalize / sidebar reflow in flight), then settles to 79. A
    // 12-frame-budget reconcile would have stopped at frame 12 — still wide,
    // leaving the PTY pinned. The convergent loop keeps watching while hidden.
    const NARROW_AT = 15
    const pane = createTimelinePane((frame) =>
      frame < NARROW_AT ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 }
    )
    const { resize } = runReconcile({ measure: pane.measure, isAuthoritative: () => false })

    expect(resize).toHaveBeenCalled()
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('forwards a narrow settle that lands LATE while hidden — no fixed frame floor', () => {
    // The bug the adversarial review caught: a fixed MIN-frames floor (e.g. 24)
    // would treat the still-wide spawn measurement as "settled" and stop before
    // the real narrowing lands. A split that equalizes at frame 40 while the
    // pane is still hidden must STILL be forwarded — the loop watches until it
    // becomes authoritative (where onResize takes over) or the hard cap.
    const NARROW_AT = 40
    const pane = createTimelinePane((frame) =>
      frame < NARROW_AT ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 }
    )
    const { resize } = runReconcile({ measure: pane.measure, isAuthoritative: () => false })

    expect(resize).toHaveBeenCalled()
    expect(resize).toHaveBeenLastCalledWith(79, 50)
  })

  it('forwards a late settle that lands just before the pane becomes authoritative', () => {
    // Realistic handoff: hidden through the settle, narrows at frame 40, then
    // the pane becomes visible at frame 45. The reconcile must have already
    // forwarded the narrow width during the hidden window (its resize bypasses
    // the visibility gate); the later authoritative+stable state lets it stop.
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
    // Handoff boundary (verified design): once the pane is authoritative AND the
    // grid has been stable for the settle window, the live onResize /
    // ResizeObserver path owns any FURTHER reflow (it fires on every
    // grid-changing fit() and is not suppressed for a visible desktop pane). So
    // the reconcile is allowed to stop here — a split that equalizes much later,
    // after this handoff, is caught by that backstop, not by the reconcile. This
    // pins that the reconcile terminates promptly in the steady visible state
    // rather than polling to the hard cap. The narrow-while-hidden window (where
    // onResize is dropped) is covered by the dedicated tests above.
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const { resize, framesRun } = runReconcile({ measure: pane.measure })
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith(79, 50)
    // Frame 1 forwards the single change (resets the window); frames 2..9 are
    // authoritative + unchanged, so the loop settles exactly at SETTLE_FRAMES(8)
    // observed-stable frames — i.e. 9 frames total, far short of the 180 cap.
    expect(framesRun).toBe(9)
  })

  it('keeps polling through unmeasurable frames (pane has no layout yet)', () => {
    // A fresh split mount can be unmeasurable for many frames before the real
    // grid lands. Unmeasurable frames must NOT count as "settled".
    const NARROW_AT = 20
    const pane = createTimelinePane((frame) => (frame < NARROW_AT ? null : { cols: 80, rows: 24 }))
    const { resize } = runReconcile({ measure: pane.measure })

    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith(80, 24)
  })

  it('hands off (stops) once authoritative and the grid has been stable', () => {
    // Once visible and stable, the live onResize owns future corrections; the
    // reconcile should stop rather than poll to the hard cap forever.
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }))
    const { framesRun } = runReconcile({ measure: pane.measure })
    // Should settle a few frames after the single resize, well short of the cap.
    expect(framesRun).toBeGreaterThan(0)
    expect(framesRun).toBeLessThan(180)
  })

  it('does NOT hand off while hidden — keeps watching until the hard cap', () => {
    // While never authoritative, a stable grid is not a safe stopping point
    // (onResize cannot back us up), so the loop runs to the hard cap.
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
    // 203 → 120 → 79 over the first frames, then stable. The TUI should see the
    // size change a small, bounded number of times during its own startup.
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
    // Parked frames are SKIPPED, not cancelled: if mobile transiently drives the
    // PTY during the mount window and then hands control back, the reconcile must
    // resume and forward the settled desktop width — not abort permanently.
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
    // While parked, measure()/resize() are skipped; after take-back the desktop
    // width is measured and forwarded exactly once.
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

  // Why: the grid being stable only proves what the loop SENT held steady, not
  // what the PTY APPLIED. transport.resize is fire-and-forget for daemon/SSH
  // PTYs, so the loop can settle on a size the PTY dropped — the mount-time twin
  // of the resume drift. getAppliedSize lets the loop confirm before handing off.
  describe('applied-size verification before handoff', () => {
    /** Drain frames, flushing microtasks between each so async getAppliedSize
     *  promises resolve and influence the next frame (mirrors real rAF timing). */
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
      // xterm settles narrow immediately, but the PTY never applies it: every
      // applied-size read reports the stale wide spawn width.
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

      // The loop must have re-forwarded the narrow size more than once (the
      // initial settle plus at least one verify-driven re-forward) and only
      // terminated at the hard cap, never falsely handing off on a dropped size.
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
      // A mobile-driven PTY legitimately sits at phone dims (≠ our desktop grid).
      // The parked gate must suppress the verify entirely so we never spin
      // re-forwarding a desktop size the mobile gate would drop.
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
      // The race: the applied-size read is issued while NOT parked (desktop owns
      // the PTY), but a mobile client takes it over and parks it at phone dims
      // before the async read resolves. The resolution must re-check parked and
      // skip the re-forward — otherwise it clobbers the phone dims with a
      // desktop SIGWINCH. Regression for the visibility-resume mobile-fit leak.
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
        // The PTY reports the stale wide size, so a parked-blind loop would
        // re-forward the narrow desktop grid on resolution.
        getAppliedSize: async () => {
          // Park the PTY while this read is in flight.
          parked = true
          return { cols: 203, rows: 50 }
        },
        requestFrame: scheduler.requestFrame,
        cancelFrame: scheduler.cancelFrame
      })
      await runAsync(scheduler, 400)

      // The only forwards allowed are the pre-park settle ones (79x50 while
      // desktop owned the PTY); no forward may fire AFTER the override parked it.
      // With the fix, the verify-driven re-forward at 79x50 is suppressed, so the
      // narrow size is forwarded at most once (the initial settle), never again.
      const narrowForwards = resize.mock.calls.filter((c) => c[0] === 79 && c[1] === 50)
      expect(narrowForwards.length).toBeLessThanOrEqual(1)
    })
  })
})
