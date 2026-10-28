import type { NativeChatApi, NativeChatAppendedMessages } from '../../../../preload/api-types'
import { isWebClientLocation } from '@/lib/web-client-location'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  parseRuntimeNativeChatReadSessionResult,
  parseRuntimeNativeChatTurnLifecycle,
  RUNTIME_NATIVE_CHAT_READ_ERROR
} from './native-chat-runtime-contract'

/** Match local IPC so session consumers can read local or runtime-owned transcripts. */
export type NativeChatSessionTransport = Pick<NativeChatApi, 'readSession' | 'subscribe'>

const RUNTIME_TOO_OLD =
  'This remote runtime is too old to show agent chat history. Update the remote runtime to view it.'

export const RUNTIME_NATIVE_CHAT_RECONNECT_MS = 2_000

/** Label only method/version blocks as update requirements; transient failures need generic copy (KTD-4). */
export function toRuntimeNativeChatErrorMessage(err: unknown): string {
  if (err instanceof RuntimeRpcCallError && err.code === 'method_not_found') {
    return RUNTIME_TOO_OLD
  }
  if (isRuntimeCompatBlockError(err)) {
    return RUNTIME_TOO_OLD
  }
  return RUNTIME_NATIVE_CHAT_READ_ERROR
}

/** Web IPC already targets its paired runtime; preserve sync desktop and deferred web teardown forms. */
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
          { agent, sessionId, limit, transcriptPath, capabilities: { transcriptSourceOrder: 1 } },
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

      // Reconnect established streams after drops; merge replay by id. Initial failures surface once instead of retrying.
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
              params: {
                subscriptionId,
                agent,
                sessionId,
                transcriptPath,
                limit,
                capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
              },
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
                  pending?: boolean
                }
                const lifecycle = parseRuntimeNativeChatTurnLifecycle(frame?.lifecycle)
                // Pending frames stop the spinner without claiming a settled initial transcript.
                const pending = frame?.pending === true
                if (
                  (frame?.type === 'appended' ||
                    frame?.type === 'snapshot' ||
                    frame?.type === 'replacement') &&
                  Array.isArray(frame.messages)
                ) {
                  if (!receivedInitial) {
                    if (!pending) {
                      receivedInitial = true
                    }
                    onFrame({
                      type: 'snapshot',
                      messages: frame.messages,
                      hasMore: frame.hasMore ?? frame.messages.length >= (limit ?? 300),
                      ...(frame.error ? { error: frame.error } : {}),
                      ...(lifecycle ? { lifecycle } : {}),
                      ...(pending ? { pending: true } : {})
                    })
                  } else if (frame.type === 'snapshot') {
                    onFrame({
                      type: 'snapshot',
                      messages: frame.messages,
                      hasMore: frame.hasMore ?? false,
                      ...(frame.error ? { error: frame.error } : {}),
                      ...(lifecycle ? { lifecycle } : {}),
                      ...(pending ? { pending: true } : {})
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
                  // Settle unrecognized successful payloads with an empty snapshot/error so loading cannot remain stuck.
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: [],
                    hasMore: false,
                    ...(frame?.error ? { error: frame.error } : {})
                  })
                }
              },
              // Teardown also closes the stream; cancelled prevents its reconnect.
              onError: () => scheduleReconnect(attempt),
              onClose: () => scheduleReconnect(attempt)
            }
          )
          .then((handle) => {
            // Stale reconnect handles must never replace or tear down the current stream.
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
            // Initial failures use the direct-read compatibility message.
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
            // Failed reconnects remain transient; retain backoff retries for live views.
            scheduleReconnect(attempt)
          })
      }

      openStream()

      // Socket closure reaps its watcher; an unsubscribe RPC would use the wrong connection cleanup key.
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

/** Only desktop runtime-owned panes need this adapter; web and local/SSH panes keep the IPC bridge. */
export function getNativeChatSessionTransport(
  runtimeEnvironmentId: string | null
): NativeChatSessionTransport {
  if (runtimeEnvironmentId && !isWebClientLocation()) {
    return createRuntimeNativeChatTransport(runtimeEnvironmentId)
  }
  return localNativeChatTransport
}
