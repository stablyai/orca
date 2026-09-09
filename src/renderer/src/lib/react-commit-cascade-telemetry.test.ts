import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCrashReportDetails } from '../../../shared/crash-report-redaction'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../shared/react-update-depth-attribution'
import {
  REACT_CASCADING_LANES,
  setReactCommitCascadeRendererSurface,
  REACT_COMMIT_CASCADE_ARM_COMMITS,
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  createReactCommitCascadeState,
  recordReactCommit,
  resetReactCommitCascadeTelemetryForTests,
  type ReactCommitCascadeState
} from './react-commit-cascade-telemetry'
import {
  noteReactCommitCascadeStoreWrite,
  reactCommitCascadeWriteProbe,
  readReactCommitCascadeWriteSummary
} from './react-commit-cascade-store-write-samples'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const ROOT = { pendingLanes: 2 }
const OTHER_ROOT = { pendingLanes: 2 }
/** SyncLane; what react-dom leaves pending on a cascading commit. */
const SYNC_LANE = 2
/** Any lane outside React's nested-update mask ends the cascade. */
const IDLE_LANE = 1_073_741_824

function cascadePayload(callIndex = 0): Record<string, unknown> {
  const call = recordBreadcrumb.mock.calls[callIndex]
  return (call?.[1] ?? {}) as Record<string, unknown>
}

function driveCommits(args: {
  state: ReactCommitCascadeState
  count: number
  root?: unknown
  lanes?: number
  nowMs?: number
  onCommit?: () => void
}): void {
  const readNowMs = (): number => args.nowMs ?? 1_000
  for (let index = 0; index < args.count; index += 1) {
    recordReactCommit({
      state: args.state,
      root: args.root ?? ROOT,
      pendingLanes: args.lanes ?? SYNC_LANE,
      readNowMs
    })
    args.onCommit?.()
  }
}

beforeEach(() => {
  recordBreadcrumb.mockClear()
  resetReactCommitCascadeTelemetryForTests()
})

// Why asserted: both thresholds only mean anything relative to React's own bail.
// If the notice limit ever meets it, the crumb stops beating the throw.
describe('cascade thresholds', () => {
  it('derives arm and notice limits from React commit budget', () => {
    expect(REACT_COMMIT_CASCADE_NOTICE_LIMIT).toBeLessThan(REACT_NESTED_UPDATE_LIMIT)
    expect(REACT_COMMIT_CASCADE_ARM_COMMITS).toBeLessThan(REACT_COMMIT_CASCADE_NOTICE_LIMIT)
    expect(REACT_CASCADING_LANES).toBe(42)
  })
})

describe('recordReactCommit', () => {
  it('stays silent below the notice limit', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })

    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(state.commits).toBe(REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1)
  })

  it('fires exactly once at the notice limit and not again in the same cascade', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT * 3 })

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb.mock.calls[0]?.[0]).toBe(REACT_COMMIT_CASCADE_BREADCRUMB)
    expect(cascadePayload().commits).toBe(REACT_COMMIT_CASCADE_NOTICE_LIMIT)
  })

  it('emits flat primitives only', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT })

    const payload = cascadePayload()
    expect(
      Object.values(payload).every((value) => value === null || typeof value !== 'object')
    ).toBe(true)
    expect(payload).toMatchObject({
      commits: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      commitBudget: REACT_NESTED_UPDATE_LIMIT,
      pendingLanes: SYNC_LANE,
      storeWrites: 0,
      storeWriteSites: 0,
      rendererSurface: 'main'
    })
  })

  // Why this is the whole reset rule: React zeroes its counter the moment a
  // commit leaves no sync lanes pending, so a lull must not accumulate.
  it('ends the cascade when the root stops holding cascading lanes', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })

    driveCommits({ state, count: 1, lanes: 0 })

    expect(state.commits).toBe(0)
    expect(state.cascadeRoot).toBeNull()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('ignores lanes outside React nested-update mask', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT * 2, lanes: IDLE_LANE })

    expect(state.commits).toBe(0)
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  // Why per root: React's counter is root-global but not cross-root, so two
  // roots alternating commits are not one cascade.
  it('restarts the count when a different root commits', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })

    driveCommits({ state, count: 1, root: OTHER_ROOT })

    expect(state.commits).toBe(1)
    expect(state.cascadeRoot).toBe(OTHER_ROOT)
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('honours explicit limit overrides', () => {
    const state = createReactCommitCascadeState()
    for (let index = 0; index < 4; index += 1) {
      recordReactCommit({
        state,
        root: ROOT,
        pendingLanes: SYNC_LANE,
        readNowMs: () => 1_000,
        noticeLimit: 4,
        armCommits: 2
      })
    }

    expect(cascadePayload().commits).toBe(4)
  })

  // Why asserted: a clock read per commit is the one cost this design refuses.
  it('reads the clock only at arm and at report', () => {
    const state = createReactCommitCascadeState()
    const readNowMs = vi.fn(() => 1_000)
    for (let index = 0; index < REACT_COMMIT_CASCADE_NOTICE_LIMIT; index += 1) {
      recordReactCommit({ state, root: ROOT, pendingLanes: SYNC_LANE, readNowMs })
    }

    expect(readNowMs).toHaveBeenCalledTimes(2)
  })
})

// Why asserted: the popout is a separate BrowserWindow with its own module
// state, so the payload is the only thing that says which window cascaded.
describe('renderer surface', () => {
  it('reports the surface the cascade happened on', () => {
    setReactCommitCascadeRendererSurface('dashboard-popout')
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT })

    expect(cascadePayload().rendererSurface).toBe('dashboard-popout')
  })
})

describe('driver attribution', () => {
  it('arms write sampling at the arm floor, not before', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_ARM_COMMITS - 1 })
    expect(reactCommitCascadeWriteProbe.armed).toBe(false)

    driveCommits({ state, count: 1 })
    expect(reactCommitCascadeWriteProbe.armed).toBe(true)
  })

  it('names the driving write with a path-free frame', () => {
    const state = createReactCommitCascadeState()
    function drivingWrite(): void {
      noteReactCommitCascadeStoreWrite(drivingWrite, { tabs: [] })
    }
    driveCommits({
      state,
      count: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      onCommit: () => {
        if (reactCommitCascadeWriteProbe.armed) {
          drivingWrite()
        }
      }
    })

    const payload = cascadePayload()
    expect(payload.storeWrites).toBeGreaterThan(0)
    // Why the caller and not drivingWrite itself: captureStackTrace elides the
    // boundary frame, so in production the first frame is whoever called `set`.
    expect(String(payload.driverFrame)).toContain('onCommit')
    expect(payload.changedKeys).toBe('tabs')
    // Why: the path redaction is keyed on the detail NAME, so a path inside the
    // value would ship a developer's home directory.
    expect(String(payload.driverStack)).not.toContain('/')
    // Why sanitize instead of matching the key name: the 4000-char budget is
    // decided by a camel-split rule in crash-report-redaction, so a hand-copied
    // regex here can pass while the real rule drops the frames to 240.
    // Why resolve the key from the payload: hard-coding it here is the same
    // drift this assertion exists to catch.
    const stackKey = Object.keys(payload).find(
      (key) => key !== 'driverFrame' && String(payload[key]).includes(String(payload.driverFrame))
    )
    expect(stackKey).toBeDefined()
    const longFrames = 'a'.repeat(600)
    const sanitized = sanitizeCrashReportDetails({ ...payload, [stackKey as string]: longFrames })
    expect(String(sanitized[stackKey as string])).toHaveLength(longFrames.length)
  })

  it('clears samples when a cascade ends', () => {
    const state = createReactCommitCascadeState()
    function drivingWrite(): void {
      noteReactCommitCascadeStoreWrite(drivingWrite, { tabs: [] })
    }
    driveCommits({
      state,
      count: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      onCommit: () => {
        if (reactCommitCascadeWriteProbe.armed) {
          drivingWrite()
        }
      }
    })
    recordBreadcrumb.mockClear()

    driveCommits({ state, count: 1, lanes: 0 })
    driveCommits({
      state,
      count: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      nowMs: 1_000 + REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS + 1
    })

    expect(cascadePayload().storeWrites).toBe(0)
    expect(cascadePayload().driverFrame).toBeUndefined()
  })
})

describe('report throttle', () => {
  it('suppresses cascades inside the interval and carries the count forward', () => {
    const state = createReactCommitCascadeState()
    for (let cascade = 0; cascade < 3; cascade += 1) {
      driveCommits({ state, count: 1, lanes: 0 })
      driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(state.suppressed).toBe(2)

    driveCommits({ state, count: 1, lanes: 0 })
    driveCommits({
      state,
      count: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      nowMs: 1_000 + REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS + 1
    })

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
    expect(cascadePayload(1).suppressed).toBe(2)
    expect(state.suppressed).toBe(0)
  })
})

/**
 * Why dimensional and not just functional: a cascade that ends releases its
 * samples, but a renderer that oscillates for minutes runs that arm/end cycle
 * thousands of times, and anything the reset misses accumulates there.
 */
describe('repeated arm and end cycles', () => {
  const CYCLES = 1_000
  /** The steady state is a few KB of live objects; a per-cycle leak is megabytes. */
  const MAX_HEAP_GROWTH_BYTES = 1_000_000

  function drivingWrite(): void {
    noteReactCommitCascadeStoreWrite(drivingWrite, { tabs: [], panes: [] })
  }

  function runCascadeCycle(state: ReactCommitCascadeState): void {
    driveCommits({
      state,
      count: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      onCommit: () => {
        if (reactCommitCascadeWriteProbe.armed) {
          drivingWrite()
        }
      }
    })
    driveCommits({ state, count: 1, lanes: 0 })
  }

  it('leaves nothing behind across a thousand cascades', () => {
    const collectGarbage = (globalThis as { gc?: () => void }).gc
    // --expose-gc is pinned in config/vitest.config.ts execArgv.
    expect(typeof collectGarbage).toBe('function')
    const state = createReactCommitCascadeState()
    for (let warmup = 0; warmup < 20; warmup += 1) {
      runCascadeCycle(state)
    }
    collectGarbage?.()
    const before = process.memoryUsage().heapUsed

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      runCascadeCycle(state)
    }
    collectGarbage?.()

    expect(process.memoryUsage().heapUsed - before).toBeLessThan(MAX_HEAP_GROWTH_BYTES)
    expect(reactCommitCascadeWriteProbe.armed).toBe(false)
    expect(readReactCommitCascadeWriteSummary()).toMatchObject({
      storeWrites: 0,
      storeWriteSites: 0,
      driverFrame: undefined,
      driverStack: undefined,
      changedKeys: undefined
    })
    expect(state.cascadeRoot).toBeNull()
  })
})
