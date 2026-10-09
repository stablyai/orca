// The one layout client (design 3.1): the `layout.subscribe` stream over the same transport-agnostic
// RPC path for the local runtime and a remote server. It holds no layout; frames go to the caller's
// read-only cache. Unused until the switch.

import { withReconnectJitter } from '../../../shared/reconnect-jitter'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutChangeFrame,
  type WorkspaceLayoutStreamFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from './runtime-client-target'
import { onRuntimeEnvironmentsRetired } from './runtime-environment-revision'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

/**
 * `retrying`: waiting to reopen a lost stream. `refused`: this stream can never be served again
 * (the host refused it, or the server was removed or replaced), so the client stopped; a new
 * pairing needs a new subscription.
 */
export type RuntimeLayoutStreamStatus =
  | { state: 'connecting' | 'live' | 'retrying' | 'closed' }
  | { state: 'refused'; code: string }

const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 5000
// An older host without the method, a scope that denies it, or a host that no longer accepts this
// pairing: a retry gets the same answer.
const REFUSAL_CODES = ['method_not_found', 'forbidden', 'unauthorized'] as const
const RETIRED: RuntimeLayoutStreamStatus = { state: 'refused', code: 'runtime_environment_retired' }

/**
 * Opens the stream and keeps it open: after a lost stream it resubscribes, and the new snapshot
 * replaces the cache. `onFrame` gets a snapshot first, then that stream's changes.
 */
export function subscribeRuntimeLayout(
  target: RuntimeClientTarget,
  params: { workspaces?: 'all' | string[] },
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
  onStatus: (status: RuntimeLayoutStreamStatus) => void
): { close: () => void } {
  // Bumped whenever a stream is given up, so its late callbacks change nothing.
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let state: RuntimeLayoutStreamStatus['state'] = 'connecting'

  const setStatus = (status: RuntimeLayoutStreamStatus): void => {
    state = status.state
    onStatus(status)
  }

  const release = (): void => {
    generation += 1
    handle?.unsubscribe()
    handle = null
  }

  const stop = (status: RuntimeLayoutStreamStatus): void => {
    release()
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    stopRetirement()
    setStatus(status)
  }

  const stopRetirement =
    target.kind === 'environment'
      ? onRuntimeEnvironmentsRetired((ids) => {
          if (ids.includes(target.environmentId)) {
            stop(RETIRED)
          }
        })
      : () => {}

  const lose = (streamGeneration: number, error?: unknown): void => {
    if (streamGeneration !== generation) {
      return
    }
    if (error !== undefined) {
      console.warn('[workspace-layout] layout stream lost:', error)
    }
    const refusal = REFUSAL_CODES.find((code) => hasRuntimeRpcErrorCode(error, code))
    if (refusal) {
      stop({ state: 'refused', code: refusal })
      return
    }
    release()
    setStatus({ state: 'retrying' })
    const delay = withReconnectJitter(Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS))
    failures += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void open()
    }, delay)
  }

  const receive = (
    streamGeneration: number,
    frame: WorkspaceLayoutStreamFrame | 'unknown' | 'malformed'
  ): void => {
    if (streamGeneration !== generation || frame === 'unknown') {
      return
    }
    if (frame === 'malformed' || (frame.type !== 'snapshot' && state !== 'live')) {
      // A frame the cache cannot apply, or a change before the snapshot: the cache would drift
      // from the host, so a fresh snapshot replaces it.
      lose(streamGeneration, new Error('Layout stream out of order or malformed'))
      return
    }
    if (frame.type === 'end') {
      lose(streamGeneration)
      return
    }
    if (frame.type === 'snapshot') {
      setStatus({ state: 'live' })
    } else {
      // A change after the snapshot proves the stream stays up, unlike a snapshot then a drop.
      failures = 0
    }
    onFrame(frame)
  }

  const open = async (): Promise<void> => {
    const streamGeneration = ++generation
    setStatus({ state: 'connecting' })
    try {
      const opened = await subscribeRuntimeRpc(target, 'layout.subscribe', params, {
        onEvent: (result) => receive(streamGeneration, readWorkspaceLayoutStreamFrame(result)),
        onError: (error) => lose(streamGeneration, error),
        onClose: () => lose(streamGeneration)
      })
      if (streamGeneration !== generation) {
        opened.unsubscribe()
        return
      }
      handle = opened
    } catch (error) {
      lose(streamGeneration, error)
    }
  }

  void open()
  return {
    close: () => {
      if (state !== 'closed' && state !== 'refused') {
        stop({ state: 'closed' })
      }
    }
  }
}
