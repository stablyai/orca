import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { slowTaskRequiredIdleMs } from '@/components/right-sidebar/coalesced-poll-runner'

const HOSTED_REVIEW_REVALIDATION_IDLE_MULTIPLIER = 5
const HOSTED_REVIEW_REVALIDATION_MAX_INTERVAL_MS = 5 * 60_000

export const inflightHostedReviewRequests = new Map<
  string,
  {
    promise: Promise<HostedReviewInfo | null>
    force: boolean
    generation: number
    startedAt: number
  }
>()

export const hostedReviewRequestGenerations = new Map<string, number>()
type HostedReviewRevalidationLane = {
  inFlight: Promise<HostedReviewInfo | null> | null
  lastRunDurationMs: number
  lastRunEndedAt: number
  pendingStartRequest: (() => Promise<HostedReviewInfo | null>) | null
  timer: ReturnType<typeof setTimeout> | null
}
const hostedReviewRevalidationLanes = new Map<string, HostedReviewRevalidationLane>()

export function hostedReviewRequestKey(cacheKey: string, hintKey: string): string {
  return `${cacheKey}\0${hintKey}`
}

function requiredHostedReviewRevalidationIdleMs(lane: HostedReviewRevalidationLane): number {
  return slowTaskRequiredIdleMs(
    lane.lastRunDurationMs,
    HOSTED_REVIEW_REVALIDATION_IDLE_MULTIPLIER,
    0,
    HOSTED_REVIEW_REVALIDATION_MAX_INTERVAL_MS
  )
}

function clearHostedReviewRevalidationTimer(lane: HostedReviewRevalidationLane): void {
  if (lane.timer !== null) {
    clearTimeout(lane.timer)
    lane.timer = null
  }
}

function scheduleHostedReviewRevalidationLane(
  requestKey: string,
  lane: HostedReviewRevalidationLane
): void {
  if (lane.inFlight || lane.timer !== null) {
    return
  }
  const allowedAt = lane.lastRunEndedAt + requiredHostedReviewRevalidationIdleMs(lane)
  const delayMs = allowedAt - Date.now()
  if (delayMs <= 0 && lane.pendingStartRequest) {
    startHostedReviewRevalidationLane(requestKey, lane)
    return
  }
  lane.timer = setTimeout(
    () => {
      lane.timer = null
      if (lane.pendingStartRequest) {
        startHostedReviewRevalidationLane(requestKey, lane)
      } else if (!lane.inFlight) {
        hostedReviewRevalidationLanes.delete(requestKey)
      }
    },
    Math.max(0, delayMs)
  )
}

function observeHostedReviewRevalidationPromise(
  requestKey: string,
  lane: HostedReviewRevalidationLane,
  promise: Promise<HostedReviewInfo | null>,
  startedAt: number
): void {
  lane.inFlight = promise
  const finish = (): void => {
    if (lane.inFlight !== promise) {
      return
    }
    lane.inFlight = null
    lane.lastRunEndedAt = Date.now()
    lane.lastRunDurationMs = lane.lastRunEndedAt - startedAt
    scheduleHostedReviewRevalidationLane(requestKey, lane)
  }
  void promise.then(finish, finish)
}

function startHostedReviewRevalidationLane(
  requestKey: string,
  lane: HostedReviewRevalidationLane
): void {
  const startRequest = lane.pendingStartRequest
  if (!startRequest) {
    return
  }
  clearHostedReviewRevalidationTimer(lane)
  lane.pendingStartRequest = null
  const startedAt = Date.now()
  const promise = startRequest()
  if (lane.inFlight !== promise) {
    observeHostedReviewRevalidationPromise(requestKey, lane, promise, startedAt)
  }
}

export function supersedeHostedReviewRevalidation(
  requestKey: string,
  request: { promise: Promise<HostedReviewInfo | null>; startedAt: number }
): void {
  const lane = hostedReviewRevalidationLanes.get(requestKey)
  if (!lane) {
    return
  }
  clearHostedReviewRevalidationTimer(lane)
  lane.pendingStartRequest = null
  observeHostedReviewRevalidationPromise(requestKey, lane, request.promise, request.startedAt)
}

export function queueHostedReviewRevalidation(
  requestKey: string,
  startRequest: () => Promise<HostedReviewInfo | null>,
  inflightRequest?: {
    promise: Promise<HostedReviewInfo | null>
    startedAt: number
    force: boolean
  }
): void {
  if (inflightRequest?.force) {
    supersedeHostedReviewRevalidation(requestKey, inflightRequest)
    return
  }
  let lane = hostedReviewRevalidationLanes.get(requestKey)
  if (!lane) {
    lane = {
      inFlight: null,
      lastRunDurationMs: 0,
      lastRunEndedAt: -Infinity,
      pendingStartRequest: null,
      timer: null
    }
    hostedReviewRevalidationLanes.set(requestKey, lane)
  }
  lane.pendingStartRequest = startRequest
  if (!lane.inFlight && inflightRequest) {
    observeHostedReviewRevalidationPromise(
      requestKey,
      lane,
      inflightRequest.promise,
      inflightRequest.startedAt
    )
    return
  }
  scheduleHostedReviewRevalidationLane(requestKey, lane)
}

/** @internal - exposed for leak-regression tests only */
export function _getHostedReviewRequestGenerationCountForTest(): number {
  return hostedReviewRequestGenerations.size
}

/** @internal - exposed for leak-regression tests only */
export function _clearHostedReviewRequestGenerationsForTest(): void {
  hostedReviewRequestGenerations.clear()
  inflightHostedReviewRequests.clear()
  for (const lane of hostedReviewRevalidationLanes.values()) {
    clearHostedReviewRevalidationTimer(lane)
  }
  hostedReviewRevalidationLanes.clear()
}

/** Records a freshly issued request in the in-flight map and supersedes any queued revalidation for its key. */
export function registerInflightHostedReviewRequest(
  requestKey: string,
  entry: {
    promise: Promise<HostedReviewInfo | null>
    force: boolean
    generation: number
    startedAt: number
  }
): void {
  inflightHostedReviewRequests.set(requestKey, entry)
  supersedeHostedReviewRevalidation(requestKey, {
    promise: entry.promise,
    startedAt: entry.startedAt
  })
}
