import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCrashReportDetails } from '../../../shared/crash-report-redaction'
import {
  REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  createReactCommitCascadeState,
  recordReactCommit,
  resetReactCommitCascadeTelemetryForTests,
  type ReactCommitCascadeState
} from './react-commit-cascade-telemetry'
import {
  noteReactCommitCascadeStoreWrite,
  reactCommitCascadeWriteProbe
} from './react-commit-cascade-store-write-samples'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const ROOT = { pendingLanes: 2 }
const OTHER_ROOT = { pendingLanes: 2 }
/** SyncLane; what react-dom leaves pending on a cascading commit. */
const SYNC_LANE = 2

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

describe('recordReactCommit', () => {
  // No pending synchronous lanes resets React’s counter; lulls must never accumulate depth.
  it('ends the cascade when the root stops holding cascading lanes', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })

    driveCommits({ state, count: 1, lanes: 0 })

    expect(state.commits).toBe(0)
    expect(state.cascadeRoot).toBeNull()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  // React counts per root; alternating roots are not one cascade.
  it('restarts the count when a different root commits', () => {
    const state = createReactCommitCascadeState()
    driveCommits({ state, count: REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1 })

    driveCommits({ state, count: 1, root: OTHER_ROOT })

    expect(state.commits).toBe(1)
    expect(state.cascadeRoot).toBe(OTHER_ROOT)
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})

describe('driver attribution', () => {
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
    // captureStackTrace elides the boundary; production frame zero must identify the caller of set.
    expect(String(payload.driverFrame)).toContain('onCommit')
    expect(payload.changedKeys).toBe('tabs')
    // Detail-name redaction cannot remove paths inside values; check real payload sanitization/budget keys rather than duplicating camel-split rules that could drift to 240 chars.
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
