/**
 * Bounded recursive size walker for renderer_memory_highwater breadcrumbs.
 *
 * Why: summarizeStateCollectionSizes counts only top-level state keys, so a
 * collection growing INSIDE a slice value — agentStatusByPaneKey[].stateHistory,
 * worktreesByRepo[][].diffComments — is invisible in every crash report we have.
 * This names the nested container instead. Pure diagnostics: it reads state,
 * changes nothing, and runs only while a memory breadcrumb is already being built
 * (at most twice per session, since each highwater threshold fires once).
 *
 * Counts can be MAGNITUDES rather than exact totals: past the caps the walker
 * samples sibling entries and scales, setting `estimated`. A run that hits a
 * budget reports what it has and sets `truncated` rather than throwing or hanging.
 */

import {
  hasOnlyFieldNameShapedKeys,
  hasRepeatedEntryShape,
  isArrayContainer,
  isCountableContainer,
  isMapContainer,
  isReportableContainer,
  isSetContainer,
  isWalkableContainer
} from './nested-container-shape'
import {
  queueNestedCollectionFrame,
  resetNestedCollectionLevelSampling,
  scaleNestedCollectionFrames,
  type NestedCollectionFrame
} from './nested-collection-level-sampling'
import {
  addNestedCollectionPathTotal,
  createNestedCollectionChildPath,
  largestNestedCollectionPaths
} from './nested-collection-path-reporting'

export type NestedCollectionSizeWalk = {
  /** Largest nested containers by entry count, keyed by path label. */
  counts: Record<string, number>
  /** Entry reads plus key reads; the walker's entire cost is proportional to this. */
  nodesVisited: number
  /** A budget cut coverage short, so counts are lower bounds. */
  truncated: boolean
  /** At least one count was scaled up from a sample of sibling entries. */
  estimated: boolean
}

// Two budgets because the two kinds of work cost differently: descending into an
// entry is real recursion, while counting a dictionary's keys is a flat ~0.12us
// per key. Both are measured in nested-collection-size-walker.test.ts.
const MAX_ENTRY_VISITS = 4000
const MAX_KEYS_SCANNED = 30_000
const MAX_KEYS_PER_CONTAINER = 20_000
const MAX_FRAME_DEPTH = 3
const MAX_FRAMES_PER_LEVEL = 128
const MAX_ENTRIES_PER_FRAME = 256
const MIN_ENTRIES_PER_FRAME = 8
const MAX_TRACKED_PATHS = 96
const MAX_PATH_LENGTH = 64
/**
 * Above this many keys a plain object is a dictionary (sample it, scale it, and
 * report its size); at or below it the object is a struct, so every field is
 * visited unsampled — otherwise a heterogeneous field like `stateHistory` could
 * be missed entirely by sampling, and its field count is noise, not a leak.
 */
const MAX_STRUCT_KEYS = 32
/**
 * Wall-clock backstop, because the node budgets cannot bound time on their own:
 * `for...in` materializes V8's enumeration cache for the WHOLE object before
 * yielding the first key, so breaking after 8 keys still costs O(object size).
 * A store holding 300k-key objects measured 3.3s without this. Blocking the
 * main thread of an already-dying renderer is worse than a partial breadcrumb,
 * so the walk reports what it has and sets `truncated`.
 */
const MAX_WALK_MS = 25

type WalkState = {
  totals: Map<string, number>
  /** performance.now() past which the walk stops, whatever budget remains. */
  deadline: number
  seen: WeakSet<object>
  entryVisits: number
  keysScanned: number
  frameCandidatesByPath: Map<string, number>
  frameReplacementCursor: Map<string, number>
  truncated: boolean
  estimated: boolean
}

/** Walks `root` a few levels deep and reports its biggest nested collections. */
export function walkNestedCollectionSizes(root: unknown, limit: number): NestedCollectionSizeWalk {
  const state: WalkState = {
    totals: new Map(),
    deadline: now() + MAX_WALK_MS,
    seen: new WeakSet(),
    entryVisits: 0,
    keysScanned: 0,
    frameCandidatesByPath: new Map(),
    frameReplacementCursor: new Map(),
    truncated: false,
    estimated: false
  }
  // Why: a diagnostic must never be the thing that breaks crash reporting.
  try {
    if (isWalkableContainer(root)) {
      state.seen.add(root)
      const rootFrame = describeFrame(root, '', 0, 1, state)
      if (isOutOfTime(state)) {
        state.truncated = true
      } else {
        walkLevels(rootFrame, state)
      }
    }
  } catch {
    state.truncated = true
  }
  return {
    counts: largestNestedCollectionPaths(state.totals, limit),
    nodesVisited: state.entryVisits + state.keysScanned,
    truncated: state.truncated,
    estimated: state.estimated
  }
}

function walkLevels(rootFrame: NestedCollectionFrame, state: WalkState): void {
  let level: NestedCollectionFrame[] = [rootFrame]
  while (level.length > 0) {
    if (state.entryVisits >= MAX_ENTRY_VISITS || isOutOfTime(state)) {
      state.truncated = true
      return
    }
    // Why half: a fat top level must not consume the whole budget before
    // reaching the depth where the leak actually hides. The last level has no
    // deeper level to save for, so it may use everything that is left.
    const remaining = MAX_ENTRY_VISITS - state.entryVisits
    const levelAllowance = level[0].depth >= MAX_FRAME_DEPTH ? remaining : Math.ceil(remaining / 2)
    const perFrame = clamp(
      Math.floor(levelAllowance / level.length),
      MIN_ENTRIES_PER_FRAME,
      MAX_ENTRIES_PER_FRAME
    )
    const next: NestedCollectionFrame[] = []
    resetNestedCollectionLevelSampling(state)
    for (const frame of level) {
      if (state.entryVisits >= MAX_ENTRY_VISITS || isOutOfTime(state)) {
        state.truncated = true
        break
      }
      scanFrame(frame, perFrame, next, state)
    }
    scaleNestedCollectionFrames(next, state.frameCandidatesByPath)
    level = next
  }
}

/** Visits a sample of one container's entries and queues their containers. */
function scanFrame(
  frame: NestedCollectionFrame,
  perFrame: number,
  next: NestedCollectionFrame[],
  state: WalkState
): void {
  // Why structs ignore perFrame: their fields are heterogeneous, so a partial
  // scan could silently omit the one field that is leaking.
  const target = frame.samplable ? Math.min(frame.size, perFrame) : frame.size
  if (target <= 0) {
    return
  }
  if (target < frame.size) {
    state.estimated = true
  }
  const scale = (frame.scale * frame.size) / target
  try {
    scanFrameEntries(frame, target, scale, next, state)
  } catch {
    // Why: one hostile getter or exotic proxy must not lose the whole walk.
    state.truncated = true
  }
}

function scanFrameEntries(
  frame: NestedCollectionFrame,
  target: number,
  scale: number,
  next: NestedCollectionFrame[],
  state: WalkState
): void {
  const container = frame.container
  if (isOutOfTime(state)) {
    state.truncated = true
    return
  }
  if (isArrayContainer(container)) {
    for (let index = 0; index < target; index += 1) {
      if (state.entryVisits >= MAX_ENTRY_VISITS || isOutOfTime(state)) {
        state.truncated = true
        return
      }
      state.entryVisits += 1
      const descriptor = Object.getOwnPropertyDescriptor(container, index)
      if (descriptor === undefined) {
        continue
      }
      if (!('value' in descriptor)) {
        state.truncated = true
        continue
      }
      visitChild(descriptor.value, null, frame, scale, next, state)
    }
    return
  }
  let seen = 0
  if (isMapContainer(container)) {
    for (const value of container.values()) {
      if (seen >= target) {
        return
      }
      if (state.entryVisits >= MAX_ENTRY_VISITS || isOutOfTime(state)) {
        state.truncated = true
        return
      }
      seen += 1
      state.entryVisits += 1
      visitChild(value, null, frame, scale, next, state)
    }
    return
  }
  // Why no hasOwn: isWalkableContainer already proved the prototype is
  // Object.prototype or null, neither of which has enumerable properties.
  for (const key in container) {
    if (seen >= target) {
      return
    }
    if (state.entryVisits >= MAX_ENTRY_VISITS || isOutOfTime(state)) {
      state.truncated = true
      return
    }
    seen += 1
    state.entryVisits += 1
    const descriptor = Object.getOwnPropertyDescriptor(container, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      state.truncated = true
      continue
    }
    visitChild(descriptor.value, key, frame, scale, next, state)
  }
}

/** Records a container child's scaled size and queues it for the next level. */
function visitChild(
  value: unknown,
  key: string | null,
  frame: NestedCollectionFrame,
  scale: number,
  next: NestedCollectionFrame[],
  state: WalkState
): void {
  if (isOutOfTime(state)) {
    state.truncated = true
    return
  }
  if (!isCountableContainer(value)) {
    return
  }
  if (isOutOfTime(state)) {
    state.truncated = true
    return
  }
  const child = value as object
  // Why: cycle safety, and shared references (EMPTY_* sentinels) counted once.
  if (state.seen.has(child)) {
    return
  }
  state.seen.add(child)
  const path = createNestedCollectionChildPath(frame, key, MAX_PATH_LENGTH)
  if (path === null) {
    return
  }
  const child_ = describeFrame(child, path, frame.depth + 1, scale, state)
  if (child_.size <= 0) {
    return
  }
  // Why depth >= 1 only: depth-0 children are the top-level keys the `store`
  // contributor already reports exactly, so recording them here adds nothing.
  // Why reportable: a struct's field count is not a collection size.
  if (frame.depth >= 1 && isReportableContainer(child, child_.size, MAX_STRUCT_KEYS)) {
    addNestedCollectionPathTotal(state, path, child_.size * scale, MAX_TRACKED_PATHS)
  }
  if (frame.depth < MAX_FRAME_DEPTH && isWalkableContainer(child)) {
    queueNestedCollectionFrame(next, child_, MAX_FRAMES_PER_LEVEL, state)
  }
}

/** Measures a container's size and classifies it as samplable or struct-shaped. */
function describeFrame(
  container: object,
  path: string,
  depth: number,
  scale: number,
  state: WalkState
): NestedCollectionFrame {
  if (isArrayContainer(container)) {
    // Array/Map indices are positional, never user strings, so `[]` always applies.
    return {
      container,
      path,
      depth,
      size: container.length,
      samplable: true,
      keysAreData: true,
      scale
    }
  }
  if (isMapContainer(container) || isSetContainer(container)) {
    return {
      container,
      path,
      depth,
      size: container.size,
      samplable: true,
      keysAreData: true,
      scale
    }
  }
  const size = countKeys(container, state)
  const samplable = size > MAX_STRUCT_KEYS
  // Why the deadline short-circuits to `true`: classification costs a for-in per
  // sampled entry, and `true` is the privacy-safe answer — keys get collapsed to
  // `[]` rather than printed. Running out of time must never start printing keys.
  // Why both rules: repeated entry shapes catch a dictionary of records, and the
  // key-syntax scan catches the rest (a dictionary whose entries differ, or has
  // only one). Either one alone leaves a hole a real branch name fits through.
  const keysAreData =
    samplable ||
    isOutOfTime(state) ||
    hasRepeatedEntryShape(container, () => isOutOfTime(state)) ||
    !hasOnlyFieldNameShapedKeys(container, () => isOutOfTime(state))
  return { container, path, depth, size, samplable, keysAreData, scale }
}

/**
 * Exact key count when the budget allows; otherwise a lower bound with
 * `truncated` set, because a silently saturating count would hide the growth
 * that is the entire signal.
 *
 * Why a per-container cap on top of the global one: without it the first huge
 * dictionary eats the whole budget and every later container measures 0, which
 * drops them from the report entirely — the same blindness this walker exists
 * to fix. Capping per container keeps every path visible.
 */
function countKeys(container: object, state: WalkState): number {
  let size = 0
  if (isOutOfTime(state)) {
    state.truncated = true
    return size
  }
  for (const _key in container) {
    size += 1
    state.keysScanned += 1
    if (
      size >= MAX_KEYS_PER_CONTAINER ||
      state.keysScanned >= MAX_KEYS_SCANNED ||
      isOutOfTime(state)
    ) {
      state.truncated = true
      break
    }
  }
  return size
}

function isOutOfTime(state: WalkState): boolean {
  return now() >= state.deadline
}

function now(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)
