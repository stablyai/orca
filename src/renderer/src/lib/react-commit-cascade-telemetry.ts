/**
 * Counts consecutive same-root commits that keep scheduling synchronous work,
 * and breadcrumbs the cascade before React #185 throws.
 *
 * Two independent signals feed the count, and the crumb names which one fired:
 *
 * 1. Lanes — a measurement. react-dom resets its nested-update counter the
 *    moment a commit leaves no cascading lanes pending and increments it
 *    otherwise, so sampling `root.pendingLanes` at commit time reproduces that
 *    reset. Known over-count: React also masks the COMMITTED lanes
 *    (`lanes & 261930`), which the devtools callback does not hand us.
 * 2. Re-entrancy — an inference. Lane sampling alone is blind to the loop class
 *    that actually reached the field: react-dom calls onCommitFiberRoot BEFORE
 *    `0 !== (pendingEffectsLanes & 3) && flushPendingEffects()` and reads
 *    `root.pendingLanes` for nestedUpdateCount only AFTER it. An external store
 *    re-render is scheduled at SyncLane (`forceStoreRerender` -> lane 2), so a
 *    store-driven useEffect loop is flushed inline, counted by React, and throws
 *    #185 — while every sample here reads 0. A commit arriving before the stack
 *    unwinds to a microtask checkpoint is that loop.
 *
 * Re-entrancy drops React's lane term entirely rather than approximating it, so
 * it also counts bursts React scores as zero nested updates: 41 same-root
 * commits inside one uninterrupted synchronous span (the first has nothing to be
 * re-entrant against) reach the notice limit with no cascade present. Nothing in
 * this app renders one root that many times without yielding — every production
 * `flushSync` is one-shot, and the per-decoration roots in useDiffCommentDecorator
 * are a distinct root each, which resets the run — and a run carrying no lane
 * evidence is discarded at the span's microtask checkpoint, so it can never
 * accumulate across spans. That is why the sampled lanes are reported RAW and
 * never synthesized, and why `evidence` ships beside them — `lanes` was measured
 * at commit time, `reentrant` (with `laneCommits: 0`) was inferred from commit
 * timing alone, and triage must not read one as the other.
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

/** Which signal counted this run's commits. See the header: only `lanes` is measured. */
export type ReactCommitCascadeEvidence = 'lanes' | 'reentrant' | 'mixed'

export type ReactCommitCascadeState = {
  /**
   * Held strongly, and never dereferenced. Any span with two or more commits
   * marks its last commit re-entrant, so the slot is set far more often than a
   * lane cascade alone would set it — and an unmounted root (the per-decoration
   * roots in useDiffCommentDecorator) must not be pinned through an idle window
   * waiting for a next commit that may never come. A run with no lane evidence
   * therefore releases the slot at its span's microtask checkpoint; a
   * lane-cascading run, which legitimately spans ticks, releases it on the next
   * commit that is neither lane-cascading nor re-entrant.
   */
  cascadeRoot: unknown
  commits: number
  /** Of `commits`, how many carried genuinely cascading lanes at commit time. */
  laneCommits: number
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
    laneCommits: 0,
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
  yieldCheckpointScheduled = false
  sawCommitSinceYield = false
  rendererSurface = 'main'
  resetReactCommitCascadeWriteSamples()
}

function endCascade(state: ReactCommitCascadeState): void {
  state.cascadeRoot = null
  state.commits = 0
  state.laneCommits = 0
  state.reported = false
  state.armedAtMs = null
  resetReactCommitCascadeWriteSamples()
}

function cascadeEvidence(state: ReactCommitCascadeState): ReactCommitCascadeEvidence {
  if (state.laneCommits === 0) {
    return 'reentrant'
  }
  return state.laneCommits === state.commits ? 'lanes' : 'mixed'
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
      // Why raw: this is the one field that says whether a cascade was observed
      // or inferred, so it never carries a lane the root did not hold.
      pendingLanes,
      laneCommits: state.laneCommits,
      evidence: cascadeEvidence(state),
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
  reentrant: boolean,
  readNowMs: () => number,
  noticeLimit: number,
  armCommits: number,
  minReportIntervalMs: number
): void {
  const laneCascading = (pendingLanes & REACT_CASCADING_LANES) !== 0
  if (!laneCascading && !reentrant) {
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
  if (laneCascading) {
    state.laneCommits += 1
  }
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
  /** The commit arrived before the stack unwound to a microtask checkpoint. */
  reentrant?: boolean
  readNowMs: () => number
  noticeLimit?: number
  armCommits?: number
  minReportIntervalMs?: number
}): void {
  recordCommit(
    args.state,
    args.root,
    args.pendingLanes,
    args.reentrant ?? false,
    args.readNowMs,
    args.noticeLimit ?? REACT_COMMIT_CASCADE_NOTICE_LIMIT,
    args.armCommits ?? REACT_COMMIT_CASCADE_ARM_COMMITS,
    args.minReportIntervalMs ?? REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS
  )
}

/**
 * Per-commit hot path: one property read, one mask, three compares, one
 * increment, plus at most one microtask per tick. No clock read and no
 * allocation until a cascade arms.
 */
export function observeReactCommit(root: unknown, pendingLanes: number): void {
  recordCommit(
    sharedState,
    root,
    pendingLanes,
    isReentrantCommit(),
    Date.now,
    REACT_COMMIT_CASCADE_NOTICE_LIMIT,
    REACT_COMMIT_CASCADE_ARM_COMMITS,
    REACT_COMMIT_CASCADE_MIN_REPORT_INTERVAL_MS
  )
}

let yieldCheckpointScheduled = false
let sawCommitSinceYield = false

/** Hoisted: the hot path must not allocate a closure per tick. */
const clearYieldCheckpoint = (): void => {
  yieldCheckpointScheduled = false
  sawCommitSinceYield = false
  // A run with no lane evidence was counted purely from commits sharing one
  // synchronous span, which nothing can extend past this checkpoint. Dropping it
  // here rather than at the next commit is what keeps `cascadeRoot` from pinning
  // an unmounted root through an idle window.
  if (sharedState.cascadeRoot !== null && sharedState.laneCommits === 0) {
    endCascade(sharedState)
  }
}

// A microtask cannot run while a synchronous commit cascade is still unwinding,
// so "another commit before the checkpoint" is React's nested-update rule minus
// its lane term — over-counting the bursts the header describes.
function isReentrantCommit(): boolean {
  // Why fail closed: with no checkpoint to clear it, the flag would latch on the
  // first commit and report every later commit re-entrant for the module's life.
  if (typeof queueMicrotask !== 'function') {
    return false
  }
  const reentrant = sawCommitSinceYield
  sawCommitSinceYield = true
  if (!yieldCheckpointScheduled) {
    yieldCheckpointScheduled = true
    queueMicrotask(clearYieldCheckpoint)
  }
  return reentrant
}
