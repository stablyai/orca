/** Mirror React’s same-root synchronous pending-lane counter to report before #185. We cannot inspect committed lanes, so may overcount skipped commits and report early, never late. Passive-effect loops leave pendingLanes zero here; React tracks those separately and never throws #185 for them. */
import { compactBreadcrumbData } from '@/lib/crash-breadcrumb-data'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  armReactCommitCascadeWriteSampling,
  readReactCommitCascadeWriteSummary,
  resetReactCommitCascadeWriteSamples
} from '@/lib/react-commit-cascade-store-write-samples'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { RendererSurface } from '@/lib/renderer-memory-sampling'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../shared/react-update-depth-attribution'

export const REACT_COMMIT_CASCADE_BREADCRUMB = 'react_commit_cascade'

/**
 * SyncLane | InputContinuousLane | DefaultLane. A root still holding any of
 * these after a commit is what React counts as a nested update.
 */
export const REACT_CASCADING_LANES = 42

/** Headroom for the crumb to be built and sent before React throws above 50. */
const REACT_COMMIT_CASCADE_NOTICE_HEADROOM = 10
export const REACT_COMMIT_CASCADE_NOTICE_LIMIT =
  REACT_NESTED_UPDATE_LIMIT - REACT_COMMIT_CASCADE_NOTICE_HEADROOM
/**
 * Nothing in the app legitimately reaches 20 consecutive same-root cascading
 * commits — the two deliberate oscillation loops are capped at 8 and 3 — and it
 * leaves 20 commits for the sampled writes to land inside the loop.
 */
export const REACT_COMMIT_CASCADE_ARM_COMMITS = 20
/** Matches RENDERER_BREADCRUMB_COALESCE_MS; main drops anything faster anyway. */
export const REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS = 30_000

export type ReactCommitCascadeState = {
  // Retain only the current root until the next noncascading commit; an unmounted mid-cascade decoration root can persist in this slot.
  cascadeRoot: unknown
  commits: number
  reported: boolean
  armedAtMs: number | null
  lastReportedAtMs: number | null
  /** Cascades that reached the notice limit while the report interval was live. */
  suppressed: number
}

export function createReactCommitCascadeState(): ReactCommitCascadeState {
  return {
    cascadeRoot: null,
    commits: 0,
    reported: false,
    armedAtMs: null,
    lastReportedAtMs: null,
    suppressed: 0
  }
}

const sharedState = createReactCommitCascadeState()
let rendererSurface: RendererSurface = 'main'

export function setReactCommitCascadeRendererSurface(surface: RendererSurface): void {
  rendererSurface = surface
}

export function resetReactCommitCascadeTelemetryForTests(): void {
  Object.assign(sharedState, createReactCommitCascadeState())
  rendererSurface = 'main'
  resetReactCommitCascadeWriteSamples()
}

function endCascade(state: ReactCommitCascadeState): void {
  state.cascadeRoot = null
  state.commits = 0
  state.reported = false
  state.armedAtMs = null
  resetReactCommitCascadeWriteSamples()
}

function reportCascade(state: ReactCommitCascadeState, pendingLanes: number, nowMs: number): void {
  const suppressed = state.suppressed
  state.suppressed = 0
  state.lastReportedAtMs = nowMs
  const writes = readReactCommitCascadeWriteSummary()
  recordRendererCrashBreadcrumb(
    REACT_COMMIT_CASCADE_BREADCRUMB,
    compactBreadcrumbData({
      commits: state.commits,
      commitBudget: REACT_NESTED_UPDATE_LIMIT,
      elapsedMs: state.armedAtMs === null ? undefined : nowMs - state.armedAtMs,
      pendingLanes,
      // Why 0 is worth shipping: it says the loop is useState-driven, not store-driven.
      storeWrites: writes.storeWrites,
      storeWriteSites: writes.storeWriteSites,
      driverFrame: writes.driverFrame,
      driverStack: writes.driverStack,
      changedKeys: writes.changedKeys,
      storeListeners: readStoreListenerCount() ?? undefined,
      rendererSurface,
      suppressed: suppressed > 0 ? suppressed : undefined
    })
  )
}

function recordCommit(
  state: ReactCommitCascadeState,
  root: unknown,
  pendingLanes: number,
  readNowMs: () => number,
  noticeLimit: number,
  armCommits: number,
  minReportIntervalMs: number
): void {
  if ((pendingLanes & REACT_CASCADING_LANES) === 0) {
    if (state.cascadeRoot !== null) {
      endCascade(state)
    }
    return
  }
  if (root !== state.cascadeRoot) {
    endCascade(state)
    state.cascadeRoot = root
  }

  state.commits += 1
  if (state.commits < armCommits) {
    return
  }
  if (state.commits === armCommits) {
    state.armedAtMs = readNowMs()
    armReactCommitCascadeWriteSampling()
    return
  }
  if (state.reported || state.commits < noticeLimit) {
    return
  }

  state.reported = true
  const nowMs = readNowMs()
  // Throttle renderer sends too; every uncapped call pays structured clone plus ipcRenderer.send.
  const sinceReportMs = state.lastReportedAtMs === null ? null : nowMs - state.lastReportedAtMs
  if (sinceReportMs !== null && sinceReportMs >= 0 && sinceReportMs < minReportIntervalMs) {
    state.suppressed += 1
    return
  }
  reportCascade(state, pendingLanes, nowMs)
}

/** Injectable entry point; production uses observeReactCommit. */
export function recordReactCommit(args: {
  state: ReactCommitCascadeState
  root: unknown
  pendingLanes: number
  readNowMs: () => number
  noticeLimit?: number
  armCommits?: number
  minReportIntervalMs?: number
}): void {
  recordCommit(
    args.state,
    args.root,
    args.pendingLanes,
    args.readNowMs,
    args.noticeLimit ?? REACT_COMMIT_CASCADE_NOTICE_LIMIT,
    args.armCommits ?? REACT_COMMIT_CASCADE_ARM_COMMITS,
    args.minReportIntervalMs ?? REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS
  )
}

/**
 * Per-commit hot path: one property read, one mask, two compares, one
 * increment. No clock read and no allocation until a cascade arms.
 */
export function observeReactCommit(root: unknown, pendingLanes: number): void {
  recordCommit(
    sharedState,
    root,
    pendingLanes,
    Date.now,
    REACT_COMMIT_CASCADE_NOTICE_LIMIT,
    REACT_COMMIT_CASCADE_ARM_COMMITS,
    REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS
  )
}
