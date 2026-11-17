import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OrcaCloudEnvironmentBuildEvent } from '../../../../shared/hosted-sandbox/hosted-environment-api'
import { BuildLogBuffer } from './build-log-model'
import type { BuildLogStreamState } from './BuildLogViewer'
import { isBuildInProgress } from './cloud-environment-copy'
import type { EnvironmentBuildView, EnvironmentsApi } from './cloud-environment-types'
import { LogReplayRouter } from './log-replay'

/**
 * Backoff for re-opening a watch whose *start* failed (IPC hiccup). Dropped streams are main's job:
 * it backs off itself, emits `reconnecting`, then `reset` + replay; its `error` is terminal.
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

export function reconnectDelay(failures: number): number | null {
  return failures < RECONNECT_DELAYS_MS.length ? RECONNECT_DELAYS_MS[failures] : null
}

type StreamStatus = {
  /** `${envId}:${buildId}` the status belongs to; a status for another build is never reported. */
  key: string | null
  state: BuildLogStreamState
  error: string | null
  /** Latest build view the stream reported (status changes arrive here first). */
  build: EnvironmentBuildView | null
}

/**
 * The status to report for the build being shown. Right after switching builds the stored status
 * still belongs to the previous one: report 'connecting' rather than, say, its 'ended'.
 */
export function statusForBuild(
  status: StreamStatus,
  envId: string | null,
  buildId: string | null
): Omit<StreamStatus, 'key'> {
  if (!envId || !buildId || status.key !== `${envId}:${buildId}`) {
    return { state: 'connecting', error: null, build: null }
  }
  return { state: status.state, error: status.error, build: status.build }
}

/**
 * Watches one build's NDJSON event stream through main. The buffer is mutable and batches its own
 * renders, so log chunks never go through React state; only status/build changes do. A dropped
 * stream reconnects with backoff while the build may still be running; replays go through a
 * shadow buffer (LogReplayRouter) so the reader never sees the log empty and refill.
 */
export function useBuildLogStream(
  api: EnvironmentsApi,
  envId: string | null,
  buildId: string | null,
  onBuildChange?: (build: EnvironmentBuildView) => void,
  onEnd?: () => void
): Omit<StreamStatus, 'key'> & { buffer: BuildLogBuffer; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one buffer per build; reconnects reuse it.
  const buffer = useMemo(() => new BuildLogBuffer(), [envId, buildId])
  // The router lives as long as its buffer.
  const router = useMemo(() => new LogReplayRouter(buffer), [buffer])
  const [status, setStatus] = useState<StreamStatus>({
    key: null,
    state: 'connecting',
    error: null,
    build: null
  })
  const callbacks = useRef({ onBuildChange, onEnd })
  useLayoutEffect(() => {
    callbacks.current = { onBuildChange, onEnd }
  })
  // Consecutive failed connections for this build; reset only when the log actually grows.
  const failures = useRef(0)
  const lastBuild = useRef<EnvironmentBuildView | null>(null)
  // Which build the previous connection was for: a new connection to the same one is a reconnect.
  const connectedTo = useRef<string | null>(null)

  useEffect(() => {
    failures.current = 0
    lastBuild.current = null
  }, [envId, buildId])

  useEffect(() => {
    if (!envId || !buildId) {
      return
    }
    const key = `${envId}:${buildId}`
    let disposed = false
    let watchId: string | null = null
    let retryTimer: number | null = null
    const reconnect = connectedTo.current === key
    connectedTo.current = key
    if (reconnect) {
      router.beginReplay()
    }
    // Events can land before watchBuild resolves with our id; hold them until we know which are ours.
    const early: OrcaCloudEnvironmentBuildEvent[] = []
    setStatus((previous) =>
      reconnect && previous.key === key
        ? { ...previous, state: 'reconnecting' }
        : { key, state: 'connecting', error: null, build: null }
    )

    // `retryable`: only a failed watch start is retried here. A stream `error` event is terminal
    // (main already retried, or evicted this watch for a newer one), so retrying it would fight main.
    const lost = (message: string, retryable: boolean): void => {
      const finished = lastBuild.current !== null && !isBuildInProgress(lastBuild.current.status)
      const delay = finished || !retryable ? null : reconnectDelay(failures.current)
      failures.current += 1
      if (delay === null) {
        router.abandon()
        setStatus((previous) => ({ ...previous, key, state: 'error', error: message }))
        return
      }
      setStatus((previous) => ({ ...previous, key, state: 'reconnecting', error: message }))
      retryTimer = window.setTimeout(() => setAttempt((value) => value + 1), delay)
    }

    const handle = (payload: OrcaCloudEnvironmentBuildEvent): void => {
      const event = payload.event
      switch (event.type) {
        case 'reconnecting':
          // Main is backing off; its reopen sends `reset` and the full replay (shadow-buffered).
          setStatus((previous) => ({ ...previous, key, state: 'reconnecting' }))
          break
        case 'build':
          lastBuild.current = event.build
          setStatus((previous) => ({
            key,
            state: previous.key === key && previous.state === 'ended' ? 'ended' : 'live',
            error: null,
            build: event.build
          }))
          callbacks.current.onBuildChange?.(event.build)
          break
        case 'log':
          if (router.append(event.stream, event.data, event.at)) {
            failures.current = 0
          }
          setStatus((previous) =>
            previous.state === 'reconnecting'
              ? { ...previous, state: 'live', error: null }
              : previous
          )
          break
        case 'reset':
          router.reset()
          setStatus((previous) =>
            previous.state === 'reconnecting'
              ? { ...previous, state: 'live', error: null }
              : previous
          )
          break
        case 'end':
          router.close()
          setStatus((previous) => ({ ...previous, key, state: 'ended', error: null }))
          callbacks.current.onEnd?.()
          break
        case 'error':
          lost(event.message, false)
          break
      }
    }

    const off = api.onBuildEvent((payload) => {
      if (disposed || payload.envId !== envId || payload.buildId !== buildId) {
        return
      }
      if (watchId === null) {
        early.push(payload)
      } else if (payload.watchId === watchId) {
        handle(payload)
      }
    })

    void api
      .watchBuild(envId, buildId)
      .then((result) => {
        if (disposed) {
          if (result.ok) {
            void api.unwatchBuild(result.data.watchId)
          }
          return
        }
        if (!result.ok) {
          lost(result.error.message, true)
          return
        }
        watchId = result.data.watchId
        for (const payload of early.splice(0)) {
          if (payload.watchId === watchId) {
            handle(payload)
          }
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          lost(error instanceof Error ? error.message : String(error), true)
        }
      })

    return () => {
      disposed = true
      off()
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      if (watchId) {
        void api.unwatchBuild(watchId)
      }
    }
  }, [api, envId, buildId, router, attempt])

  const retry = useCallback(() => {
    failures.current = 0
    setAttempt((value) => value + 1)
  }, [])

  return { ...statusForBuild(status, envId, buildId), buffer, retry }
}
