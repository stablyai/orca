export const RESTORED_WORKER_GRACE_MS = 20_000
export const NEW_WORKER_GRACE_MS = 10_000
const startedAt = Date.now()
type Feeds = { startedAt: number; status: boolean; orchestration: boolean; failed: boolean }
const pending: Feeds = { startedAt, status: false, orchestration: false, failed: false }
const feeds = new Map<string, Feeds>()
let onFeedChange: (() => void) | undefined

export function registerWorkerTabFeedChangeHandler(handler: () => void): void {
  onFeedChange = handler
}

export function workerTabFeeds(hostId: string): Feeds {
  return feeds.get(hostId) ?? pending
}

export function recordWorkerTabFeed(
  hostId: string,
  event: 'status' | 'orchestration' | 'failed' | 'reconnect' | 'snapshot'
): void {
  const previous = workerTabFeeds(hostId)
  if (
    event === 'snapshot'
      ? previous.status && previous.orchestration && !previous.failed
      : event !== 'reconnect' && previous[event]
  ) {
    return
  }
  feeds.set(
    hostId,
    event === 'snapshot'
      ? { ...previous, status: true, orchestration: true, failed: false }
      : event === 'reconnect'
        ? { startedAt: Date.now(), status: false, orchestration: false, failed: false }
        : { ...previous, [event]: true }
  )
  onFeedChange?.()
}

export function workerTabGraceEndsAt(
  hostId: string,
  createdAt: number,
  now: number
): number | null {
  const feed = workerTabFeeds(hostId)
  if (feed.failed) {
    return null
  }
  const restoredEnd =
    feed.status && feed.orchestration ? 0 : feed.startedAt + RESTORED_WORKER_GRACE_MS
  const end = Math.max(restoredEnd, createdAt + NEW_WORKER_GRACE_MS)
  return end > now ? end : null
}
