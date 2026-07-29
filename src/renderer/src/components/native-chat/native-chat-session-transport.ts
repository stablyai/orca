import type { NativeChatApi, NativeChatAppendedMessages } from '../../../../preload/api-types'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  callRuntimeRpc,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  parseRuntimeNativeChatReadSessionResult,
  parseRuntimeNativeChatTurnLifecycle,
  RUNTIME_NATIVE_CHAT_READ_ERROR
} from './native-chat-runtime-contract'

/** The read/subscribe surface the live-session hook needs, decoupled from where
 *  the transcript actually lives. Same shape as `window.api.nativeChat`, so the
 *  hook and everything downstream (merge, assembler, pagination) are unchanged. */
export type NativeChatSessionTransport = Pick<NativeChatApi, 'readSession' | 'subscribe'>

const RUNTIME_TOO_OLD =
  'This remote runtime is too old to show agent chat history. Update the remote runtime to view it.'

/** Backoff before re-opening a dropped runtime chat stream. Exported for tests. */
export const RUNTIME_NATIVE_CHAT_RECONNECT_MS = 2_000

/** Map a runtime read failure to the message the read-error state renders. A
 *  version block (old runtime lacking the method, or the protocol-compat gate)
 *  gets the explicit "update the remote runtime" copy (R4); anything else — a
 *  timeout or transport error — gets a generic message, so a transient failure is
 *  never mislabeled as a version problem (KTD-4, not catch-all). */
export function toRuntimeNativeChatErrorMessage(err: unknown): string {
  if (err instanceof RuntimeRpcCallError && err.code === 'method_not_found') {
    return RUNTIME_TOO_OLD
  }
  if (isRuntimeCompatBlockError(err)) {
    return RUNTIME_TOO_OLD
  }
  return RUNTIME_NATIVE_CHAT_READ_ERROR
}

/** Delegates straight to the local Electron IPC bridge. On the web client
 *  `window.api.nativeChat` already bridges to the paired runtime, so web keeps
 *  using this adapter (R3). Preserves whatever `subscribe` returns (sync fn on
 *  desktop, promise on the web bridge) — the hook's teardown handles both (R6). */
const localNativeChatTransport: NativeChatSessionTransport = {
  readSession: (agent, sessionId, limit, transcriptPath) =>
    window.api.nativeChat.readSession(agent, sessionId, limit, transcriptPath),
  subscribe: (args, onFrame) => window.api.nativeChat.subscribe(args, onFrame)
}

function createRuntimeNativeChatTransport(environmentId: string): NativeChatSessionTransport {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId }

  return {
    readSession: async (agent, sessionId, limit, transcriptPath) => {
      try {
        const result = await callRuntimeRpc<unknown>(
          target,
          'nativeChat.readSession',
          { agent, sessionId, limit, transcriptPath },
          { timeoutMs: 15_000 }
        )
        return parseRuntimeNativeChatReadSessionResult(result)
      } catch (err) {
        return { error: toRuntimeNativeChatErrorMessage(err) }
      }
    },
    subscribe: (args, onFrame) => {
      const { subscriptionId, agent, sessionId, transcriptPath, limit } = args
      let cancelled = false
      let receivedInitial = false
      let handleUnsubscribe: (() => void) | null = null
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null
      let activeAttempt = 0
      let reconnectPendingAttempt: number | null = null

      // A mid-stream drop (runtime restart, network blip, relay reconnect) closes
      // the dedicated stream socket. Re-open it after a short backoff so the live
      // tail resumes without a manual chat toggle; the fresh drain re-emits the
      // windowed tail, which merges by id so no turn is duplicated. An initial
      // connect failure lands in `.catch` instead (and is surfaced through the
      // initial error frame), so a too-old/absent runtime never spins here.
      const scheduleReconnect = (attempt: number): void => {
        if (attempt !== activeAttempt) {
          return
        }
        handleUnsubscribe = null
        reconnectPendingAttempt = attempt
        if (cancelled || reconnectTimer) {
          return
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          reconnectPendingAttempt = null
          if (!cancelled) {
            openStream()
          }
        }, RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      }

      const openStream = (): void => {
        const attempt = ++activeAttempt
        void window.api.runtimeEnvironments
          .subscribe(
            {
              selector: environmentId,
              method: 'nativeChat.subscribe',
              params: { subscriptionId, agent, sessionId, transcriptPath, limit },
              timeoutMs: 15_000
            },
            {
              onResponse: (response) => {
                if (cancelled || attempt !== activeAttempt) {
                  return
                }
                if (response.ok === false) {
                  if (!receivedInitial) {
                    receivedInitial = true
                    onFrame({
                      type: 'snapshot',
                      messages: [],
                      hasMore: false,
                      error: toRuntimeNativeChatErrorMessage(new RuntimeRpcCallError(response))
                    })
                  } else {
                    handleUnsubscribe?.()
                    scheduleReconnect(attempt)
                  }
                  return
                }
                const frame = response.result as {
                  type?: string
                  messages?: NativeChatAppendedMessages
                  hasMore?: boolean
                  error?: string
                  lifecycle?: unknown
                }
                const lifecycle = parseRuntimeNativeChatTurnLifecycle(frame?.lifecycle)
                if (
                  (frame?.type === 'appended' ||
                    frame?.type === 'snapshot' ||
                    frame?.type === 'replacement') &&
                  Array.isArray(frame.messages)
                ) {
                  if (!receivedInitial) {
                    receivedInitial = true
                    onFrame({
                      type: 'snapshot',
                      messages: frame.messages,
                      hasMore: frame.hasMore ?? frame.messages.length >= (limit ?? 300),
                      ...(frame.error ? { error: frame.error } : {}),
                      ...(lifecycle ? { lifecycle } : {})
                    })
                  } else if (frame.type === 'snapshot') {
                    onFrame({
                      type: 'snapshot',
                      messages: frame.messages,
                      hasMore: frame.hasMore ?? false,
                      ...(frame.error ? { error: frame.error } : {}),
                      ...(lifecycle ? { lifecycle } : {})
                    })
                  } else {
                    onFrame(
                      frame.type === 'replacement'
                        ? {
                            type: 'replacement',
                            messages: frame.messages,
                            hasMore: frame.hasMore ?? false,
                            ...(lifecycle ? { lifecycle } : {})
                          }
                        : {
                            type: 'appended',
                            messages: frame.messages,
                            ...(lifecycle ? { lifecycle } : {})
                          }
                    )
                  }
                } else if (!receivedInitial) {
                  // Why: an ok response whose payload shape we don't recognize
                  // would otherwise never flip receivedInitial, stranding the view
                  // on 'loading'. Settle it with an empty snapshot (carrying any
                  // error the runtime sent) so the UI resolves.
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: [],
                    hasMore: false,
                    ...(frame?.error ? { error: frame.error } : {})
                  })
                }
              },
              // Established-then-dropped: resume the tail. onClose also fires on our
              // own teardown, but `cancelled` short-circuits the reconnect there.
              onError: () => scheduleReconnect(attempt),
              onClose: () => scheduleReconnect(attempt)
            }
          )
          .then((handle) => {
            // Why: reconnect attempts may resolve out of order. A stale handle
            // must never replace or tear down the current stream.
            if (cancelled || attempt !== activeAttempt || reconnectPendingAttempt === attempt) {
              handle.unsubscribe()
              return
            }
            handleUnsubscribe = handle.unsubscribe
          })
          .catch((err: unknown) => {
            if (cancelled || attempt !== activeAttempt) {
              return
            }
            // Initial subscribe failed (e.g. a too-old runtime lacking the method).
            // Surface the same compatibility-specific copy as a direct read.
            if (!receivedInitial) {
              receivedInitial = true
              onFrame({
                type: 'snapshot',
                messages: [],
                hasMore: false,
                error: toRuntimeNativeChatErrorMessage(err)
              })
              return
            }
            // Why: a failed reconnect is still a transient dropped-stream state;
            // keep retrying after the backoff instead of stranding a live view.
            scheduleReconnect(attempt)
          })
      }

      openStream()

      // Teardown closes the dedicated stream socket; the runtime reaps its
      // fs-watcher on that connection's close (registerSubscriptionCleanup →
      // cleanupSubscriptionsForConnection), so no explicit nativeChat.unsubscribe
      // RPC is needed — and one would ride a different connection and never match
      // the watcher's cleanup key anyway.
      return () => {
        cancelled = true
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        reconnectPendingAttempt = null
        handleUnsubscribe?.()
        handleUnsubscribe = null
      }
    }
  }
}

/** Select the read/subscribe transport for a pane. Route to the remote runtime
 *  only for a `runtime:`-owned pane on a non-web client (KTD-2); web and
 *  local/`ssh:`-owned panes keep the local adapter. */
export function getNativeChatSessionTransport(
  runtimeEnvironmentId: string | null
): NativeChatSessionTransport {
  if (runtimeEnvironmentId && !isWebClientLocation()) {
    return createRuntimeNativeChatTransport(runtimeEnvironmentId)
  }
  return localNativeChatTransport
}
