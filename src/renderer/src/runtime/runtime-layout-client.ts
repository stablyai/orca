// The one layout client (design 3.1): commands and the `layout.subscribe` stream over a transport,
// the same code for the local runtime and a remote server. It holds no layout; frames go to the
// caller's read-only cache. Unused until the switch.

import {
  readWorkspaceLayoutStreamFrame,
  type WorkspaceLayoutStreamFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { WorkspaceLayoutCacheFrame } from '../store/workspace-layout-cache'
import type { RuntimeClientTarget } from './runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { subscribeRuntimeRpc, type RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'

export type RuntimeLayoutTransport = {
  call: (method: string, params: unknown) => Promise<unknown>
  subscribe: (
    method: string,
    params: unknown,
    handlers: RuntimeRpcSubscriptionHandlers
  ) => Promise<{ unsubscribe: () => void }>
}

/** The local runtime or a paired server; nothing past this point knows which. */
export function runtimeLayoutTransport(target: RuntimeClientTarget): RuntimeLayoutTransport {
  return {
    call: (method, params) => callRuntimeRpc(target, method, params),
    subscribe: (method, params, handlers) => subscribeRuntimeRpc(target, method, params, handlers)
  }
}

/** `refused`: the host answered that it will never serve this stream, so the client stopped. */
export type RuntimeLayoutStreamStatus =
  | { state: 'connecting' | 'live' | 'retrying' | 'closed' }
  | { state: 'refused'; code: string; message: string }

export type RuntimeLayoutSubscription = {
  status: () => RuntimeLayoutStreamStatus
  close: () => void
}

export type RuntimeLayoutClient = {
  command: (method: `layout.${string}`, params: unknown) => Promise<unknown>
  /**
   * Opens the stream and keeps it open: after a lost stream it resubscribes, and the new snapshot
   * replaces the cache. `onFrame` gets a snapshot first, then that stream's changes. A refusal
   * stops it for good.
   */
  subscribe: (
    params: { workspaces?: 'all' | string[] },
    onFrame: (frame: WorkspaceLayoutCacheFrame) => void,
    onStatus?: (status: RuntimeLayoutStreamStatus) => void
  ) => RuntimeLayoutSubscription
}

const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 5000
// An older host without the method, or a caller scope denied it: a retry gets the same answer.
const REFUSAL_CODES: ReadonlySet<string> = new Set(['method_not_found', 'forbidden'])

function readRefusal(error: unknown): { code: string; message: string } | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const code = 'code' in error ? error.code : undefined
  const message = 'message' in error ? error.message : undefined
  return typeof code === 'string' && REFUSAL_CODES.has(code)
    ? { code, message: typeof message === 'string' ? message : code }
    : null
}

export function createRuntimeLayoutClient(transport: RuntimeLayoutTransport): RuntimeLayoutClient {
  return {
    command: (method, params) => transport.call(method, params),
    subscribe: (params, onFrame, onStatus) => openLayoutStream(transport, params, onFrame, onStatus)
  }
}

function openLayoutStream(
  transport: RuntimeLayoutTransport,
  params: { workspaces?: 'all' | string[] },
  onFrame: (frame: WorkspaceLayoutCacheFrame) => void,
  onStatus?: (status: RuntimeLayoutStreamStatus) => void
): RuntimeLayoutSubscription {
  let status: RuntimeLayoutStreamStatus = { state: 'connecting' }
  const setStatus = (next: RuntimeLayoutStreamStatus): void => {
    status = next
    onStatus?.(next)
  }
  let closed = false
  // Fences frames from a stream this client already gave up on.
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failures = 0

  const lose = (streamGeneration: number, error?: unknown): void => {
    if (closed || streamGeneration !== generation) {
      return
    }
    generation += 1
    handle?.unsubscribe()
    handle = null
    const refusal = readRefusal(error)
    if (refusal) {
      closed = true
      setStatus({ state: 'refused', ...refusal })
      return
    }
    if (error !== undefined) {
      console.warn('[workspace-layout] layout stream lost:', error)
    }
    setStatus({ state: 'retrying' })
    const delay = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS)
    failures += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void open()
    }, delay)
  }

  const receive = (
    streamGeneration: number,
    state: { awaitingSnapshot: boolean },
    frame: WorkspaceLayoutStreamFrame | null
  ): void => {
    if (closed || streamGeneration !== generation) {
      return
    }
    if (!frame) {
      // A newer host's frame type, or a malformed frame; neither may change the cache.
      return
    }
    if (frame.type === 'end') {
      lose(streamGeneration)
      return
    }
    if (frame.type === 'snapshot') {
      state.awaitingSnapshot = false
      failures = 0
      setStatus({ state: 'live' })
    } else if (state.awaitingSnapshot) {
      // The host sends the snapshot first; a change before it has nothing to replace.
      return
    }
    onFrame(frame)
  }

  const open = async (): Promise<void> => {
    const streamGeneration = ++generation
    const state = { awaitingSnapshot: true }
    try {
      const opened = await transport.subscribe('layout.subscribe', params, {
        onEvent: (result) =>
          receive(streamGeneration, state, readWorkspaceLayoutStreamFrame(result)),
        onError: (error) => lose(streamGeneration, error),
        onClose: () => lose(streamGeneration)
      })
      if (closed || streamGeneration !== generation) {
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
    status: () => status,
    close: () => {
      if (closed) {
        return
      }
      closed = true
      setStatus({ state: 'closed' })
      generation += 1
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      handle?.unsubscribe()
      handle = null
    }
  }
}
