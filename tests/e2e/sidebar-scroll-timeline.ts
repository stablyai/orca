import { expect } from './helpers/orca-app'

export type SidebarScrollGeometry = {
  top: number
  height: number
  viewportHeight: number
  contentTop: number
  contentHeight: number
  contentVisible: boolean
}

export type SidebarScrollSample = {
  time: number
  scrollTop: number
  geometry: SidebarScrollGeometry | null
  highlighted?: boolean
}

type ScrollOptions = {
  captureTimedOut?: boolean
  allowOversized?: boolean
  topInset?: number
}

function geometryVector(geometry: SidebarScrollGeometry, scrollTop: number): number[] {
  return [
    scrollTop,
    geometry.top,
    geometry.height,
    geometry.viewportHeight,
    geometry.contentTop,
    geometry.contentHeight
  ]
}

function isVisible(geometry: SidebarScrollGeometry, options: ScrollOptions): boolean {
  // Matches the existing 28px group header plus 6px reveal clearance.
  const topInset = options.topInset ?? 34
  const contentVisible =
    geometry.contentVisible &&
    geometry.contentHeight > 0 &&
    geometry.contentTop >= topInset &&
    geometry.contentTop + geometry.contentHeight <= geometry.viewportHeight
  if (!contentVisible || geometry.height <= 0) {
    return false
  }
  if (options.allowOversized && geometry.height > geometry.viewportHeight - topInset) {
    return Math.abs(geometry.top - topInset) <= 2
  }
  return geometry.top >= topInset && geometry.top + geometry.height <= geometry.viewportHeight
}

function findVisibleEndpoint(samples: SidebarScrollSample[], options: ScrollOptions) {
  let start = samples.length
  let minimum: number[] = []
  let maximum: number[] = []
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]
    if (!sample.geometry || !isVisible(sample.geometry, options)) {
      break
    }
    const vector = geometryVector(sample.geometry, sample.scrollTop)
    const low = vector.map((value, axis) => Math.min(value, minimum[axis] ?? value))
    const high = vector.map((value, axis) => Math.max(value, maximum[axis] ?? value))
    if (high.some((value, axis) => value - low[axis] > 2)) {
      break
    }
    minimum = low
    maximum = high
    start = index
  }
  let proofStart = start
  for (let index = start + 1; index < samples.length; index++) {
    if (samples[index].time - samples[index - 1].time >= 200) {
      proofStart = index
    }
    if (samples[index].time - samples[proofStart].time >= 350) {
      return { arrivalIndex: proofStart, confirmedAtMs: samples[index].time }
    }
  }
  return null
}

export function measureSidebarScroll(
  samples: SidebarScrollSample[],
  initialOffset = 0,
  options: ScrollOptions = {}
) {
  const malformed =
    !Number.isFinite(initialOffset) ||
    samples.some(
      (sample, index) =>
        !Number.isFinite(sample.time) ||
        !Number.isFinite(sample.scrollTop) ||
        sample.time < 0 ||
        (index > 0 && sample.time <= samples[index - 1].time) ||
        (sample.geometry != null &&
          !geometryVector(sample.geometry, sample.scrollTop).every(Number.isFinite))
    )
  const invalid = malformed || samples.length === 0 || options.captureTimedOut === true
  const endpoint = invalid ? null : findVisibleEndpoint(samples, options)
  const arrival = endpoint ? samples[endpoint.arrivalIndex] : null
  const finalOffset = arrival?.scrollTop ?? null
  const direction = finalOffset === null ? null : Math.sign(finalOffset - initialOffset)
  const distance = finalOffset === null ? null : Math.abs(finalOffset - initialOffset)
  const moving = malformed
    ? []
    : samples.slice(0, (endpoint?.arrivalIndex ?? samples.length - 1) + 1)
  const firstMotion = moving.find((sample) => Math.abs(sample.scrollTop - initialOffset) > 2)
  let lastOffset = initialOffset
  let stationarySince = 0
  let longestPause = 0
  let laterPause = 0
  let maxFrameGap = 0
  let maxInMotionFrameGap = 0
  for (const [index, sample] of moving.entries()) {
    // Include startup, the next movement's interval, and an unfinished stationary tail.
    const pause = sample.time - stationarySince
    longestPause = Math.max(longestPause, pause)
    if (firstMotion && stationarySince >= firstMotion.time) {
      laterPause = Math.max(laterPause, pause)
    }
    const gap = sample.time - (moving[index - 1]?.time ?? 0)
    maxFrameGap = Math.max(maxFrameGap, gap)
    if (firstMotion && sample.time > firstMotion.time) {
      maxInMotionFrameGap = Math.max(maxInMotionFrameGap, gap)
    }
    if (sample.scrollTop !== lastOffset) {
      lastOffset = sample.scrollTop
      stationarySince = sample.time
    }
  }
  const intermediate = samples.filter((sample) => {
    if (direction === null || distance === null) {
      return false
    }
    const progress = direction * (sample.scrollTop - initialOffset)
    return progress > 0 && progress < distance - 2
  })
  const observedThroughMs = samples.at(-1)?.time ?? null
  return {
    status: invalid
      ? ('invalid' as const)
      : endpoint
        ? ('complete' as const)
        : ('censored' as const),
    reason: malformed
      ? 'invalid sample values or ordering'
      : samples.length === 0
        ? 'no observed frames'
        : options.captureTimedOut
          ? 'animation frame capture timed out'
          : endpoint
            ? null
            : 'no continuously observed stable visible endpoint',
    initialOffset,
    finalOffset,
    lastObservedOffset: samples.at(-1)?.scrollTop ?? null,
    observedThroughMs,
    arrivalMs: arrival?.time ?? null,
    confirmedAtMs: endpoint?.confirmedAtMs ?? null,
    initialDelayMs: firstMotion?.time ?? null,
    initialDelayLowerBoundMs: firstMotion?.time ?? observedThroughMs,
    longestPause,
    laterPause,
    openTailPauseMs: endpoint || malformed ? 0 : (observedThroughMs ?? 0) - stationarySince,
    maxFrameGap,
    maxInMotionFrameGap,
    direction,
    intermediateSamples: intermediate.length,
    intermediateOffsets: new Set(intermediate.map((sample) => sample.scrollTop)).size,
    // Coverage is diagnostic: native motion can cross several bands between observations.
    observedProgressBands: new Set(
      intermediate.map((sample) =>
        Math.floor((5 * (direction ?? 0) * (sample.scrollTop - initialOffset)) / (distance || 1))
      )
    ).size,
    maxReverseStep:
      direction === null
        ? null
        : Math.max(
            0,
            ...samples.map(
              (sample, index) =>
                direction * ((samples[index - 1]?.scrollTop ?? initialOffset) - sample.scrollTop)
            )
          ),
    maxOvershoot:
      direction === null || distance === null
        ? null
        : Math.max(
            0,
            ...samples.map((sample) => direction * (sample.scrollTop - initialOffset) - distance)
          ),
    highlightedAfterArrival:
      arrival !== null &&
      endpoint !== null &&
      samples.some((sample) => sample.time >= arrival.time && sample.highlighted === true)
  }
}

export function isSidebarScrollIntermediate(
  sample: { scrollTop: number },
  metrics: ReturnType<typeof measureSidebarScroll>
): boolean {
  if (metrics.finalOffset === null || metrics.direction === null) {
    return false
  }
  const progress = metrics.direction * (sample.scrollTop - metrics.initialOffset)
  return progress > 0 && progress < Math.abs(metrics.finalOffset - metrics.initialOffset) - 2
}

export function expectSidebarScrollProgress(metrics: ReturnType<typeof measureSidebarScroll>) {
  expect(metrics.status, `${metrics.reason}; observed through ${metrics.observedThroughMs}ms`).toBe(
    'complete'
  )
  // Distinct positions reject jump-only motion, but cannot rule out four tiny steps then a jump.
  expect(
    metrics.intermediateOffsets,
    'distinct intermediate scroll positions'
  ).toBeGreaterThanOrEqual(4)
  expect(metrics.initialDelayMs, 'dispatch-to-first-motion delay').toBeLessThan(200)
  expect(metrics.maxFrameGap, 'dispatch-to-landing observed frame gap').toBeLessThan(200)
}
