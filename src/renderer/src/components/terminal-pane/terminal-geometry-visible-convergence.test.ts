import { describe, expect, it, vi } from 'vitest'
import {
  reconcilePtySizeAcrossFrames,
  type PtySizeReconcileDimensions,
  type PtySizeReconcileOptions
} from './pty-size-reconcile'

type Geometry = PtySizeReconcileDimensions

type ShellVisibleState = {
  reason: 'not-modeled-at-renderer-unit-layer'
  state: 'degraded'
}

type TerminalGeometrySnapshot = {
  providerApplied: Geometry
  proposed: Geometry | null
  shellVisible: ShellVisibleState
  xterm: Geometry
}

type VisibleConvergenceResult = {
  framesRun: number
  getAppliedSize: ReturnType<typeof vi.fn>
  pendingFrames: number
  resize: ReturnType<typeof vi.fn>
  snapshot: TerminalGeometrySnapshot
}

const SHELL_VISIBLE_NOT_MODELED: ShellVisibleState = {
  reason: 'not-modeled-at-renderer-unit-layer',
  state: 'degraded'
}

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

async function drainScheduledFrames(
  scheduler: ReturnType<typeof createFrameScheduler>,
  maxFrames = 1000
): Promise<number> {
  let ran = 0
  while (scheduler.pending() > 0 && ran < maxFrames) {
    ran += scheduler.run(1)
    // Applied-size verification resolves between animation frames in the app.
    await Promise.resolve()
    await Promise.resolve()
  }
  return ran
}

function isUsableGeometry(size: Geometry): boolean {
  return size.cols > 0 && size.rows > 0
}

function assertTerminalGeometryConverged(
  result: VisibleConvergenceResult,
  expected: Geometry
): void {
  expect(result.snapshot.xterm, 'xterm must settle to the expected visible grid').toEqual(expected)
  expect(result.snapshot.proposed, 'fit/proposed size must agree with xterm').toEqual(expected)
  expect(
    result.snapshot.providerApplied,
    'provider-applied PTY size must confirm the visible grid'
  ).toEqual(expected)
  expect(result.snapshot.shellVisible).toEqual(SHELL_VISIBLE_NOT_MODELED)
  expect(result.pendingFrames, 'reconcile must stop after convergence').toBe(0)
  expect(result.framesRun, 'convergence should finish before the hard frame cap').toBeLessThan(180)
}

async function runVisibleConvergenceScenario(options: {
  authoritativeAtFrame?: (frame: number) => boolean
  maxFrames?: number
  onResize?: (size: Geometry, callIndex: number, applied: Geometry) => Geometry
  spawn: Geometry
  timeline: (frame: number) => Geometry | null
}): Promise<VisibleConvergenceResult> {
  const scheduler = createFrameScheduler()
  const resize = vi.fn()
  let frame = 0
  let providerApplied = options.spawn
  const getAppliedSize = vi.fn(async () => providerApplied)
  let proposed: Geometry | null = null
  let xterm = options.spawn

  const measure: PtySizeReconcileOptions['measure'] = vi.fn(() => {
    const measured = options.timeline(frame)
    frame += 1
    proposed = measured
    if (measured && isUsableGeometry(measured)) {
      xterm = measured
    }
    return measured
  })

  reconcilePtySizeAcrossFrames({
    spawnCols: options.spawn.cols,
    spawnRows: options.spawn.rows,
    isAlive: () => true,
    isParked: () => false,
    isAuthoritative: () => options.authoritativeAtFrame?.(frame) ?? true,
    measure,
    resize: (cols, rows) => {
      const next = { cols, rows }
      const callIndex = resize.mock.calls.length + 1
      resize(cols, rows)
      providerApplied = options.onResize?.(next, callIndex, providerApplied) ?? next
    },
    getAppliedSize,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  })

  const framesRun = await drainScheduledFrames(scheduler, options.maxFrames)
  return {
    framesRun,
    getAppliedSize,
    pendingFrames: scheduler.pending(),
    resize,
    snapshot: {
      providerApplied,
      proposed,
      shellVisible: SHELL_VISIBLE_NOT_MODELED,
      xterm
    }
  }
}

describe('terminal-geometry.visible-convergence oracle', () => {
  it('rejects an initial 0x0 visible measurement and converges after layout settles', async () => {
    const expected = { cols: 118, rows: 32 }
    const result = await runVisibleConvergenceScenario({
      spawn: { cols: 0, rows: 0 },
      timeline: (frame) => {
        if (frame === 0) {
          return { cols: 0, rows: 0 }
        }
        return frame < 4 ? null : expected
      }
    })

    assertTerminalGeometryConverged(result, expected)
    expect(result.resize).toHaveBeenCalledTimes(1)
  })

  it('keeps visible convergence alive through a hidden delayed layout settle', async () => {
    const expected = { cols: 79, rows: 50 }
    const result = await runVisibleConvergenceScenario({
      authoritativeAtFrame: (frame) => frame >= 45,
      spawn: { cols: 203, rows: 50 },
      timeline: (frame) => (frame < 40 ? { cols: 203, rows: 50 } : expected)
    })

    assertTerminalGeometryConverged(result, expected)
    expect(result.resize).toHaveBeenLastCalledWith(expected.cols, expected.rows)
  })

  it('does not trust requested size when the provider drops the first resize ack', async () => {
    const expected = { cols: 88, rows: 24 }
    const result = await runVisibleConvergenceScenario({
      spawn: { cols: 203, rows: 50 },
      timeline: () => expected,
      onResize: (size, callIndex, applied) => (callIndex === 1 ? applied : size)
    })

    assertTerminalGeometryConverged(result, expected)
    expect(result.resize.mock.calls).toEqual([
      [expected.cols, expected.rows],
      [expected.cols, expected.rows]
    ])
    expect(result.getAppliedSize).toHaveBeenCalledTimes(2)
  })
})
