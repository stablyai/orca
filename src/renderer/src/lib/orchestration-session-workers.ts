// One read per chat, shared by every surface that draws its workers; polled only while one is visible and a worker runs.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  ORCHESTRATION_SESSION_WORKERS_METHOD,
  sessionWorkerIsRunning,
  type OrchestrationSessionWorker,
  type OrchestrationSessionWorkersResult
} from '../../../shared/orchestration-session-workers'

const POLL_MS = 3_000
const NO_WORKERS: readonly OrchestrationSessionWorker[] = []

type Feed = {
  target: RuntimeClientTarget
  sessionId: string
  workers: readonly OrchestrationSessionWorker[]
  listeners: Set<() => void>
  visibleViewers: number
  reading: boolean
  rereadQueued: boolean
  /** An older host without the method answers nothing, so the feed stops asking. */
  unsupported: boolean
  /** The host announces this session's worker events, so new transcript rows need no re-read. */
  workerNotices: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const feeds = new Map<string, Feed>()

function feedKey(target: RuntimeClientTarget, sessionId: string): string {
  return `${target.kind === 'environment' ? target.environmentId : 'local'}:${sessionId}`
}

function feedFor(target: RuntimeClientTarget, sessionId: string): Feed {
  const key = feedKey(target, sessionId)
  let feed = feeds.get(key)
  if (!feed) {
    feed = {
      target,
      sessionId,
      workers: NO_WORKERS,
      listeners: new Set(),
      visibleViewers: 0,
      reading: false,
      rereadQueued: false,
      unsupported: false,
      workerNotices: false,
      timer: null
    }
    feeds.set(key, feed)
  }
  return feed
}

function workersEqual(
  a: readonly OrchestrationSessionWorker[],
  b: readonly OrchestrationSessionWorker[]
): boolean {
  return a.length === b.length && a.every((worker, index) => sameWorker(worker, b[index]!))
}

function sameWorker(a: OrchestrationSessionWorker, b: OrchestrationSessionWorker): boolean {
  return (
    a.dispatchId === b.dispatchId &&
    a.title === b.title &&
    a.agent === b.agent &&
    a.state === b.state &&
    a.activity === b.activity &&
    a.pendingQuestion === b.pendingQuestion &&
    a.liveness === b.liveness &&
    a.host === b.host &&
    a.worktreeId === b.worktreeId &&
    a.address === b.address &&
    a.paneKey === b.paneKey &&
    a.chatSessionId === b.chatSessionId &&
    a.startedAt === b.startedAt &&
    a.settledAt === b.settledAt &&
    a.summary === b.summary
  )
}

function schedule(feed: Feed): void {
  if (feed.timer) {
    clearTimeout(feed.timer)
    feed.timer = null
  }
  if (
    feed.unsupported ||
    feed.listeners.size === 0 ||
    feed.visibleViewers === 0 ||
    !feed.workers.some(sessionWorkerIsRunning)
  ) {
    return
  }
  feed.timer = setTimeout(() => {
    feed.timer = null
    void readFeed(feed)
  }, POLL_MS)
}

async function readFeed(feed: Feed): Promise<void> {
  if (feed.unsupported) {
    return
  }
  if (feed.reading) {
    feed.rereadQueued = true
    return
  }
  feed.reading = true
  try {
    const result = await callRuntimeRpc<OrchestrationSessionWorkersResult>(
      feed.target,
      ORCHESTRATION_SESSION_WORKERS_METHOD,
      { session: feed.sessionId },
      // A 3 s poll: no use of an idle WSL host (#46567).
      { suppressFeatureInteraction: true, background: true }
    )
    feed.workerNotices = result.workerNotices === true
    const workers = result.workers.length === 0 ? NO_WORKERS : result.workers
    if (!workersEqual(feed.workers, workers)) {
      feed.workers = workers
      for (const listener of feed.listeners) {
        listener()
      }
    }
  } catch (error) {
    if (isMethodNotFound(error)) {
      feed.unsupported = true
    }
  } finally {
    feed.reading = false
    if (feed.rereadQueued) {
      feed.rereadQueued = false
      void readFeed(feed)
    } else {
      schedule(feed)
    }
  }
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

/** A new transcript row may be the command that started a worker; only an older host, which
 *  announces no worker events, needs the re-read. */
export function rereadOrchestrationSessionWorkersOnNewRow(
  target: RuntimeClientTarget,
  sessionId: string
): void {
  const feed = feedFor(target, sessionId)
  if (!feed.workerNotices) {
    void readFeed(feed)
  }
}

/** The host's notice that one of the session's workers started or changed state; a feed nobody
 *  reads waits for its first reader. */
export function noteOrchestrationSessionWorkersChanged(
  environmentId: string | null,
  sessionId: string
): void {
  const feed = feeds.get(`${environmentId ?? 'local'}:${sessionId}`)
  if (feed && feed.listeners.size > 0) {
    void readFeed(feed)
  }
}

/** Several chats' workers at once (a bot's sessions), each from its own shared feed. */
export function useOrchestrationSessionsWorkers(
  target: RuntimeClientTarget,
  sessionIds: readonly string[],
  { visible }: { visible: boolean }
): ReadonlyMap<string, readonly OrchestrationSessionWorker[]> {
  const sessionKey = sessionIds.join('\n')
  const sessionFeeds = useMemo(
    () => (sessionKey ? sessionKey.split('\n') : []).map((id) => feedFor(target, id)),
    [target, sessionKey]
  )
  const snapshot = useRef<{
    lists: readonly (readonly OrchestrationSessionWorker[])[]
    value: ReadonlyMap<string, readonly OrchestrationSessionWorker[]>
  } | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => {
      for (const feed of sessionFeeds) {
        feed.listeners.add(listener)
      }
      return () => {
        for (const feed of sessionFeeds) {
          feed.listeners.delete(listener)
          if (feed.listeners.size === 0) {
            schedule(feed)
          }
        }
      }
    },
    [sessionFeeds]
  )
  const read = useCallback(() => {
    const lists = sessionFeeds.map((feed) => feed.workers)
    const previous = snapshot.current
    if (
      previous &&
      previous.lists.length === lists.length &&
      previous.lists.every((list, index) => list === lists[index])
    ) {
      return previous.value
    }
    const value = new Map(sessionFeeds.map((feed) => [feed.sessionId, feed.workers]))
    snapshot.current = { lists, value }
    return value
  }, [sessionFeeds])
  const workers = useSyncExternalStore(subscribe, read, read)
  useEffect(() => {
    if (!visible) {
      return
    }
    for (const feed of sessionFeeds) {
      feed.visibleViewers += 1
      void readFeed(feed)
    }
    return () => {
      for (const feed of sessionFeeds) {
        feed.visibleViewers -= 1
        schedule(feed)
      }
    }
  }, [sessionFeeds, visible])
  return workers
}
