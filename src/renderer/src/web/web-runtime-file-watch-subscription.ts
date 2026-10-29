import type { RuntimeRpcResponse, RuntimeRpcSuccess } from '../../../shared/runtime-rpc-envelope'
import type {
  WebRuntimeSubscriptionCallbacks,
  WebRuntimeTransportSubscriptionHandle
} from './web-runtime-subscription-contract'

type FileWatchSubscriptionOptions = {
  params: unknown
  callbacks: WebRuntimeSubscriptionCallbacks
  subscribe: (
    callbacks: WebRuntimeSubscriptionCallbacks
  ) => Promise<WebRuntimeTransportSubscriptionHandle>
  call: (
    method: string,
    params: unknown,
    options: { timeoutMs: number }
  ) => Promise<RuntimeRpcResponse<unknown>>
  teardownRetries: Map<string, Set<() => Promise<void>>>
}

export async function subscribeWebRuntimeFileWatch({
  params,
  callbacks,
  subscribe,
  call,
  teardownRetries
}: FileWatchSubscriptionOptions): Promise<WebRuntimeTransportSubscriptionHandle> {
  const teardownKey = JSON.stringify(params) ?? String(params)
  await Promise.all(Array.from(teardownRetries.get(teardownKey) ?? [], (retry) => retry()))
  let stopped = false
  let remoteSubscriptionId: string | null = null
  let transportInterrupted = false
  let pendingReplayResync = false
  let unwatchStarted = false
  let handle: WebRuntimeTransportSubscriptionHandle | null = null
  const dropLocalSubscription = (): void => handle?.unsubscribe()
  let unwatchAttempt: Promise<void> | null = null

  const retryRemoteUnwatch = (): Promise<void> => {
    if (unwatchAttempt) {
      return unwatchAttempt
    }
    unwatchStarted = true
    const attempt = call(
      'files.unwatch',
      { subscriptionId: remoteSubscriptionId! },
      { timeoutMs: 5_000 }
    )
      .then((response) => {
        if (response.ok === false) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        const retries = teardownRetries.get(teardownKey)
        retries?.delete(retryRemoteUnwatch)
        if (retries?.size === 0) {
          teardownRetries.delete(teardownKey)
        }
        dropLocalSubscription()
      })
      .catch((error: unknown) => {
        console.warn('Failed to unwatch remote file subscription:', error)
        throw error
      })
      .finally(() => {
        unwatchAttempt = null
        unwatchStarted = false
      })
    unwatchAttempt = attempt
    return attempt
  }

  const unwatchAndDropLocalSubscription = (): void => {
    if (unwatchStarted) {
      return
    }
    if (!remoteSubscriptionId) {
      dropLocalSubscription()
      return
    }
    const retries = teardownRetries.get(teardownKey) ?? new Set()
    retries.add(retryRemoteUnwatch)
    teardownRetries.set(teardownKey, retries)
    void retryRemoteUnwatch().catch(() => {})
  }

  const wrappedCallbacks: WebRuntimeSubscriptionCallbacks = {
    ...callbacks,
    onResponse: (response) => {
      transportInterrupted = false
      const nextSubscriptionId = getFileWatchSubscriptionId(response)
      if (nextSubscriptionId) {
        remoteSubscriptionId = nextSubscriptionId
        if (stopped) {
          unwatchAndDropLocalSubscription()
          return
        }
      }
      if (isFileWatchStartingResponse(response)) {
        return
      }
      if (!stopped) {
        callbacks.onResponse(response)
        if (pendingReplayResync && nextSubscriptionId && response.ok) {
          pendingReplayResync = false
          callbacks.onResponse(createFileWatchReplayOverflowResponse(response, params))
        }
      } else if (response.ok === false) {
        dropLocalSubscription()
      }
    },
    onError: (error) => {
      if (!stopped) {
        callbacks.onError?.(error)
      }
    },
    onClose: () => {
      if (!stopped) {
        callbacks.onClose?.()
      }
    },
    onTransportInterrupted: () => {
      transportInterrupted = true
      remoteSubscriptionId = null
      if (!stopped) {
        return
      }
      const retries = teardownRetries.get(teardownKey)
      retries?.delete(retryRemoteUnwatch)
      if (retries?.size === 0) {
        teardownRetries.delete(teardownKey)
      }
      dropLocalSubscription()
    },
    onTransportReplayed: () => {
      transportInterrupted = false
      pendingReplayResync = true
    }
  }
  handle = await subscribe(wrappedCallbacks)

  return {
    unsubscribe: () => {
      if (stopped) {
        return
      }
      stopped = true
      if (remoteSubscriptionId) {
        unwatchAndDropLocalSubscription()
      } else if (transportInterrupted) {
        dropLocalSubscription()
      }
    },
    sendBinary: (bytes) => handle?.sendBinary(bytes)
  }
}

function getFileWatchSubscriptionId(response: RuntimeRpcResponse<unknown>): string | null {
  if (!response.ok || !response.result || typeof response.result !== 'object') {
    return null
  }
  const subscriptionId = (response.result as { subscriptionId?: unknown }).subscriptionId
  return typeof subscriptionId === 'string' ? subscriptionId : null
}

function createFileWatchReplayOverflowResponse(
  readyResponse: RuntimeRpcSuccess<unknown>,
  params: unknown
): RuntimeRpcSuccess<{
  type: 'changed'
  worktree: string
  events: { kind: 'overflow'; absolutePath: string }[]
}> {
  const worktree = (params as { worktree?: unknown } | null)?.worktree
  return {
    id: readyResponse.id,
    ok: true,
    result: {
      type: 'changed',
      worktree: typeof worktree === 'string' ? worktree : '',
      events: [{ kind: 'overflow', absolutePath: '' }]
    },
    _meta: readyResponse._meta
  }
}

function isFileWatchStartingResponse(
  response: RuntimeRpcResponse<unknown>
): response is RuntimeRpcSuccess<{ type: 'starting'; subscriptionId: string }> {
  return (
    response.ok &&
    !!response.result &&
    typeof response.result === 'object' &&
    (response.result as { type?: unknown }).type === 'starting'
  )
}
