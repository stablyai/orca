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

export type RuntimeLayoutSubscription = { close: () => void }

export type RuntimeLayoutClient = {
  command: (method: `layout.${string}`, params: unknown) => Promise<unknown>
  /**
   * Opens the stream and keeps it open: after a lost stream it resubscribes, and the new snapshot
   * replaces the cache. `onFrame` gets a snapshot first, then that stream's changes.
   */
  subscribe: (
    params: { workspaces?: 'all' | string[] },
    onFrame: (frame: WorkspaceLayoutCacheFrame) => void
  ) => RuntimeLayoutSubscription
}

const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 5000

export function createRuntimeLayoutClient(transport: RuntimeLayoutTransport): RuntimeLayoutClient {
  return {
    command: (method, params) => transport.call(method, params),
    subscribe: (params, onFrame) => openLayoutStream(transport, params, onFrame)
  }
}

function openLayoutStream(
  transport: RuntimeLayoutTransport,
  params: { workspaces?: 'all' | string[] },
  onFrame: (frame: WorkspaceLayoutCacheFrame) => void
): RuntimeLayoutSubscription {
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
    if (error !== undefined) {
      console.warn('[workspace-layout] layout stream lost:', error)
    }
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
    close: () => {
      if (closed) {
        return
      }
      closed = true
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
