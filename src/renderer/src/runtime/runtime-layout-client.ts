// The one layout client (design 3.1): the `layout.subscribe` stream over the same transport-agnostic
// RPC path for the local runtime and a remote server. It holds no layout; frames go to the caller's
// read-only cache. Unused until the switch.

import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutChangeFrame,
  type WorkspaceLayoutStreamFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from './runtime-client-target'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

/** `retrying`: waiting to reopen a lost stream. `refused`: the host answered that it will never
 *  serve this stream, so the client stopped. */
export type RuntimeLayoutStreamStatus =
  | { state: 'connecting' | 'live' | 'retrying' | 'closed' }
  | { state: 'refused'; code: string }

const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 5000
// An older host without the method, or a caller scope denied it: a retry gets the same answer.
const REFUSAL_CODES = ['method_not_found', 'forbidden'] as const

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
    setStatus(status)
  }

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
    const delay = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS)
    failures += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void open()
    }, delay)
  }

  const receive = (streamGeneration: number, frame: WorkspaceLayoutStreamFrame | null): void => {
    // Null: a newer host's frame type or an unreadable frame; neither may change the cache.
    if (streamGeneration !== generation || !frame) {
      return
    }
    if (frame.type === 'end') {
      lose(streamGeneration)
      return
    }
    if (frame.type === 'snapshot') {
      setStatus({ state: 'live' })
    } else if (state !== 'live') {
      // The host sends the snapshot first; a change before it has nothing to replace.
      return
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
