/**
 * Counts consecutive same-root commits that keep scheduling synchronous work,
 * and breadcrumbs the cascade before React #185 throws.
 *
 * This mirrors React's own accounting rather than approximating it with a time
 * window: react-dom resets its nested-update counter the moment a commit leaves
 * no sync lanes pending, and increments it otherwise. Reading `root.pendingLanes`
 * at commit time reproduces that reset exactly.
 *
 * Known over-count: React also requires the committed lanes to intersect its own
 * mask, which we cannot read from the devtools callback. Dropping that term can
 * only make us count a commit React would have skipped, so we fire early, never
 * late — the safe direction for a diagnostic that must beat the throw.
 *
 * Passive effects: after a commit whose lanes include SyncLane, react-dom
 * flushes useEffect synchronously AFTER onCommitFiberRoot and BEFORE it reads
 * pendingLanes for its counter, so a useEffect that writes a store throws #185
 * while the commit callback saw pendingLanes 0. A quiet commit therefore only
 * opens a settle window: a synchronous post-commit flush on that root
 * (observeReactPassiveFlush) supplies the lanes React actually counts, and the
 * window otherwise closes as a reset at the next observation or microtask.
 */
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
  /**
   * Held strongly, and never dereferenced. The next commit that leaves no
   * cascading lanes clears the slot — milliseconds away in a live renderer —
   * so the only tree this pins is a React root unmounted mid-cascade, such as
   * the per-decoration roots in useDiffCommentDecorator.
   */
  cascadeRoot: unknown
  commits: number
  reported: boolean
  armedAtMs: number | null
  lastReportedAtMs: number | null
  /** Cascades that reached the notice limit while the report interval was live. */
  suppressed: number
  /** Root whose quiet commit may still get cascading lanes from its sync passive flush. */
  settlingRoot: unknown
}

export function createReactCommitCascadeState(): ReactCommitCascadeState {
  return {
    cascadeRoot: null,
    commits: 0,
    reported: false,
    armedAtMs: null,
    lastReportedAtMs: null,
    suppressed: 0,
    settlingRoot: null
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

function settleCommit(state: ReactCommitCascadeState): void {
  if (state.settlingRoot === null) {
    return
  }
  state.settlingRoot = null
  if (state.cascadeRoot !== null) {
    endCascade(state)
  }
}

type CascadeLimits = {
  readNowMs: () => number
  noticeLimit: number
  armCommits: number
  minReportIntervalMs: number
}

const PRODUCTION_LIMITS: CascadeLimits = {
  readNowMs: Date.now,
  noticeLimit: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  armCommits: REACT_COMMIT_CASCADE_ARM_COMMITS,
  minReportIntervalMs: REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS
}

/** Returns true when it opened a settle window the caller must close. */
function recordCommit(
  state: ReactCommitCascadeState,
  root: unknown,
  pendingLanes: number,
  limits: CascadeLimits
): boolean {
  // A new commit means the previous one's synchronous passive flush is over.
  settleCommit(state)
  if ((pendingLanes & REACT_CASCADING_LANES) === 0) {
    state.settlingRoot = root
    return true
  }
  countCascadingCommit(state, root, pendingLanes, limits)
  return false
}

function recordPassiveFlush(
  state: ReactCommitCascadeState,
  root: unknown,
  pendingLanes: number,
  limits: CascadeLimits
): void {
  // Why only the settling root: a cascading commit was already counted, and an
  // async flush runs after React reset its counter, so either would over-count.
  if (root === null || root !== state.settlingRoot) {
    return
  }
  if ((pendingLanes & REACT_CASCADING_LANES) === 0) {
    settleCommit(state)
    return
  }
  state.settlingRoot = null
  countCascadingCommit(state, root, pendingLanes, limits)
}

function countCascadingCommit(
  state: ReactCommitCascadeState,
  root: unknown,
  pendingLanes: number,
  { readNowMs, noticeLimit, armCommits, minReportIntervalMs }: CascadeLimits
): void {
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
  // Why the renderer throttles too: nothing rate-limits this pipe, and every
  // call is a structured clone plus an ipcRenderer.send.
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
  /** A post-commit passive flush rather than the commit itself. */
  passiveFlush?: boolean
}): void {
  const limits: CascadeLimits = {
    readNowMs: args.readNowMs,
    noticeLimit: args.noticeLimit ?? REACT_COMMIT_CASCADE_NOTICE_LIMIT,
    armCommits: args.armCommits ?? REACT_COMMIT_CASCADE_ARM_COMMITS,
    minReportIntervalMs: args.minReportIntervalMs ?? REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS
  }
  if (args.passiveFlush) {
    recordPassiveFlush(args.state, args.root, args.pendingLanes, limits)
  } else {
    recordCommit(args.state, args.root, args.pendingLanes, limits)
  }
}

/** Injectable twin of settleReactCommit. */
export function settleReactCommitState(state: ReactCommitCascadeState): void {
  settleCommit(state)
}

/**
 * Per-commit hot path: one property read, one mask, two compares, one
 * increment. No clock read and no allocation until a cascade arms. Returns true
 * when the caller must schedule settleReactCommit.
 */
export function observeReactCommit(root: unknown, pendingLanes: number): boolean {
  return recordCommit(sharedState, root, pendingLanes, PRODUCTION_LIMITS)
}

/** onPostCommitFiberRoot: lanes after the passive flush, which React counts when it ran synchronously. */
export function observeReactPassiveFlush(root: unknown, pendingLanes: number): void {
  recordPassiveFlush(sharedState, root, pendingLanes, PRODUCTION_LIMITS)
}

/** Closes the settle window once the commit's synchronous work has returned. */
export function settleReactCommit(): void {
  settleCommit(sharedState)
}
