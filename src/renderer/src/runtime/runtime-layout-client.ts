// The one layout client (design 3.1): the `layout.subscribe` stream over the same transport-agnostic
// RPC path for the local runtime and a remote server. It holds no layout; frames go to the caller's
// read-only cache. Unused until the switch.

import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  readWorkspaceLayoutFramePosition,
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutChangeFrame,
  type WorkspaceLayoutStreamFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
import { exposeLocalLayoutStreamE2EEnd } from './local-layout-stream-e2e-end'

/** `lost`: the stream ended without a refusal and the client stopped. `refused`: the host answered
 *  that it will never serve this stream, so the client stopped. */
export type RuntimeLayoutStreamStatus =
  | { state: 'connecting' | 'live' | 'lost' | 'closed' }
  | { state: 'refused'; code: string }

// An older host without the method, or a caller scope denied it: a retry gets the same answer.
const REFUSAL_CODES = ['method_not_found', 'forbidden'] as const

/** First wait before a lost local stream reopens; it doubles to the cap until a snapshot comes. */
const LOCAL_REOPEN_DELAY_MS = 1_000
const LOCAL_REOPEN_DELAY_CAP_MS = 30_000

/**
 * Opens the stream; `onFrame` gets a snapshot first, then that stream's changes. A lost local
 * stream reports `lost`, then reopens, and its snapshot replaces what the caller holds. A remote
 * stream that drops reports `lost`; reopening it belongs to the connection's reconnect.
 */
export function subscribeRuntimeLayout(
  target: RuntimeClientTarget,
  params: { workspaces?: 'all' | string[] },
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
  onStatus: (status: RuntimeLayoutStreamStatus) => void,
  /** Each frame's stream position, an unreadable frame's too: a reply may name any frame. */
  onPosition?: (seq: number) => void
): { close: () => void } {
  // Bumped whenever a stream is given up, so its late callbacks change nothing.
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let state: RuntimeLayoutStreamStatus['state'] = 'connecting'
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  let reopenDelay = LOCAL_REOPEN_DELAY_MS

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
    stop(refusal ? { state: 'refused', code: refusal } : { state: 'lost' })
    // Why: layout.apply still reaches main without the stream, so only main's own changes would
    // go unseen until a relaunch.
    if (!refusal && target.kind === 'local') {
      reopenTimer = setTimeout(() => {
        reopenTimer = null
        void open()
      }, reopenDelay)
      reopenDelay = Math.min(reopenDelay * 2, LOCAL_REOPEN_DELAY_CAP_MS)
    }
  }

  const receive = (streamGeneration: number, value: unknown): void => {
    if (streamGeneration !== generation) {
      return
    }
    if (import.meta.env.MODE === 'e2e' && target.kind === 'local') {
      exposeLocalLayoutStreamE2EEnd(value)
    }
    const seq = readWorkspaceLayoutFramePosition(value)
    try {
      deliver(streamGeneration, readWorkspaceLayoutStreamFrame(value))
    } finally {
      if (seq !== undefined && streamGeneration === generation) {
        onPosition?.(seq)
      }
    }
  }

  const deliver = (streamGeneration: number, frame: WorkspaceLayoutStreamFrame | null): void => {
    // Null: a newer host's frame type or an unreadable frame; neither may change the cache.
    if (!frame) {
      return
    }
    if (frame.type === 'end') {
      lose(streamGeneration)
      return
    }
    if (frame.type === 'snapshot') {
      reopenDelay = LOCAL_REOPEN_DELAY_MS
      setStatus({ state: 'live' })
    } else if (state !== 'live') {
      // The host sends the snapshot first; a change before it has nothing to replace.
      return
    }
    onFrame(frame)
  }

  const open = async (): Promise<void> => {
    const streamGeneration = ++generation
    setStatus({ state: 'connecting' })
    try {
      const opened = await subscribeRuntimeRpc(target, 'layout.subscribe', params, {
        onEvent: (result) => receive(streamGeneration, result),
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
      if (reopenTimer) {
        clearTimeout(reopenTimer)
        reopenTimer = null
        stop({ state: 'closed' })
      } else if (state === 'connecting' || state === 'live') {
        stop({ state: 'closed' })
      }
    }
  }
}
