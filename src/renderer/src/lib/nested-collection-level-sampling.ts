export type NestedCollectionFrame = {
  container: object
  path: string
  depth: number
  size: number
  samplable: boolean
  keysAreData: boolean
  scale: number
}

export type NestedCollectionLevelSamplingState = {
  frameCandidatesByPath: Map<string, number>
  frameReplacementCursor: Map<string, number>
  truncated: boolean
  estimated: boolean
}

export function resetNestedCollectionLevelSampling(
  state: NestedCollectionLevelSamplingState
): void {
  state.frameCandidatesByPath.clear()
  state.frameReplacementCursor.clear()
}

/** Keeps every represented path at the width cap and samples within each path. */
export function queueNestedCollectionFrame(
  next: NestedCollectionFrame[],
  frame: NestedCollectionFrame,
  maxFrames: number,
  state: NestedCollectionLevelSamplingState
): void {
  state.frameCandidatesByPath.set(
    frame.path,
    (state.frameCandidatesByPath.get(frame.path) ?? 0) + 1
  )
  if (next.length < maxFrames) {
    next.push(frame)
    return
  }
  state.estimated = true
  let samePathCount = 0
  for (let index = 0; index < next.length; index += 1) {
    if (next[index].path === frame.path) {
      samePathCount += 1
    }
  }
  if (samePathCount > 0) {
    replaceSamePathFrame(next, frame, samePathCount, state)
    return
  }
  replaceRepeatedPathFrame(next, frame, state)
}

function replaceSamePathFrame(
  next: NestedCollectionFrame[],
  frame: NestedCollectionFrame,
  samePathCount: number,
  state: NestedCollectionLevelSamplingState
): void {
  const cursor = state.frameReplacementCursor.get(frame.path) ?? 0
  const replaceOrdinal = cursor % samePathCount
  let ordinal = 0
  for (let index = 0; index < next.length; index += 1) {
    if (next[index].path !== frame.path) {
      continue
    }
    if (ordinal === replaceOrdinal) {
      next[index] = frame
      break
    }
    ordinal += 1
  }
  state.frameReplacementCursor.set(frame.path, cursor + 1)
}

function replaceRepeatedPathFrame(
  next: NestedCollectionFrame[],
  frame: NestedCollectionFrame,
  state: NestedCollectionLevelSamplingState
): void {
  const retainedByPath = countFramesByPath(next)
  let replacePath: string | null = null
  let replaceCount = 1
  for (const [path, count] of retainedByPath) {
    if (count > replaceCount) {
      replacePath = path
      replaceCount = count
    }
  }
  if (replacePath === null) {
    state.truncated = true
    return
  }
  const replaceIndex = next.findIndex((retained) => retained.path === replacePath)
  next[replaceIndex] = frame
}

/** Scales each retained path independently so wide siblings cannot drown rare ones. */
export function scaleNestedCollectionFrames(
  level: NestedCollectionFrame[],
  candidatesByPath: Map<string, number>
): void {
  const retainedByPath = countFramesByPath(level)
  for (const frame of level) {
    const candidates = candidatesByPath.get(frame.path) ?? 1
    const retained = retainedByPath.get(frame.path) ?? 1
    frame.scale *= candidates / retained
  }
}

function countFramesByPath(frames: NestedCollectionFrame[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const frame of frames) {
    counts.set(frame.path, (counts.get(frame.path) ?? 0) + 1)
  }
  return counts
}
