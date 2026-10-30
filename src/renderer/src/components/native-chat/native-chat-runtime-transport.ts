import { readRuntimeNativeChatFrame } from './native-chat-runtime-frame'
import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../../../shared/agent-session-current-requests-capability'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import {
  getRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending,
  onRuntimeEnvironmentsRetired,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  parseRuntimeNativeChatReadSessionResult,
  runtimeNativeChatReadError
} from './native-chat-runtime-contract'
import { translate } from '@/i18n/i18n'
import type { NativeChatSessionTransport } from './native-chat-session-transport'

function runtimeTooOldMessage(): string {
  return translate(
    'components.native-chat.runtime.tooOld',
    'This remote runtime is too old to show agent chat history. Update the remote runtime to view it.'
  )
}

export const RUNTIME_NATIVE_CHAT_RECONNECT_MS = 2_000

/** Label only method/version blocks as update requirements; transient failures need generic copy (KTD-4). */
export function toRuntimeNativeChatErrorMessage(err: unknown): string {
  if (err instanceof RuntimeRpcCallError && err.code === 'method_not_found') {
    return runtimeTooOldMessage()
  }
  if (isRuntimeCompatBlockError(err)) {
    return runtimeTooOldMessage()
  }
  return runtimeNativeChatReadError()
}

export function createRuntimeNativeChatTransport(
  environmentId: string
): NativeChatSessionTransport {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId }
  const capturedRevision = getRuntimeEnvironmentRevision(environmentId)
  let retired = false
  let currentRequestsSupported = false
  const revision = (): number => {
    const continued =
      capturedRevision === undefined
        ? undefined
        : resolveContinuedRuntimeEnvironmentRevision(environmentId, capturedRevision)
    if (
      retired ||
      continued === undefined ||
      (continued !== getRuntimeEnvironmentRevision(environmentId) &&
        !isRuntimeEnvironmentContinuationPending(environmentId, continued))
    ) {
      throw new Error('The paired Orca server changed while the request was in progress.')
    }
    return continued
  }
  async function call<TResult>(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<TResult> {
    const expectedEnvironmentPairingRevision = revision()
    const controller = new AbortController()
    const abort = () => controller.abort()
    const stop = onRuntimeEnvironmentsRetired((ids) => {
      if (ids.includes(environmentId)) {
        retired = true
        abort()
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
    try {
      const result = await callRuntimeRpc<TResult>(target, method, params, {
        ...(signal || method === 'nativeChat.cancelCurrentQuestions'
          ? { signal: controller.signal }
          : {}),
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision,
        beforeSend: () => {
          revision()
        }
      })
      revision()
      return result
    } finally {
      stop()
      signal?.removeEventListener('abort', abort)
    }
  }

  return {
    cancelCurrentQuestions: (request) => call('nativeChat.cancelCurrentQuestions', request),
    currentRequests: (request, signal) => call('nativeChat.currentRequests', request, signal),
    readSession: async (agent, sessionId, limit, transcriptPath) => {
      try {
        const result = await call<unknown>('nativeChat.readSession', {
          agent,
          sessionId,
          limit,
          transcriptPath,
          capabilities: { transcriptSourceOrder: 1 }
        })
        return parseRuntimeNativeChatReadSessionResult(result)
      } catch (err) {
        return { error: toRuntimeNativeChatErrorMessage(err) }
      }
    },
    subscribe: (args, onFrame) => {
      const { subscriptionId, agent, sessionId, transcriptPath, limit } = args
      const probe = new AbortController()
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
        void Promise.resolve()
          .then(() =>
            runtimeEnvironmentSupportsCapability(
              environmentId,
              AGENT_SESSION_CURRENT_REQUESTS_V2,
              15_000,
              {
                expectedEnvironmentPairingRevision: revision(),
                signal: probe.signal
              }
            )
          )
          .catch(() => false)
          .then((supported) => {
            if (cancelled || attempt !== activeAttempt) {
              return { unsubscribe: () => {} }
            }
            const expectedEnvironmentPairingRevision = revision()
            currentRequestsSupported ||= supported
            return window.api.runtimeEnvironments.subscribe(
              {
                selector: environmentId,
                method: 'nativeChat.subscribe',
                params: {
                  subscriptionId,
                  agent,
                  sessionId,
                  transcriptPath,
                  limit,
                  capabilities: {
                    transcriptPending: 1,
                    transcriptSourceOrder: 1,
                    ...(currentRequestsSupported ? { currentRequests: 2 } : {})
                  }
                },
                timeoutMs: 15_000,
                expectedEnvironmentPairingRevision
              },
              {
                onResponse: (response) => {
                  if (cancelled || attempt !== activeAttempt) {
                    return
                  }
                  try {
                    revision()
                  } catch {
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
                  const delivered = readRuntimeNativeChatFrame(
                    response.result,
                    receivedInitial,
                    limit
                  )
                  receivedInitial = delivered.receivedInitial
                  if (delivered.frame) {
                    onFrame(delivered.frame)
                  }
                },
                // Teardown also closes the stream; cancelled prevents its reconnect.
                onError: () => scheduleReconnect(attempt),
                onClose: () => scheduleReconnect(attempt)
              }
            )
          })
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

      const stopRetirement = onRuntimeEnvironmentsRetired((ids) => {
        if (!ids.includes(environmentId)) {
          return
        }
        retired = true
        probe.abort()
        cancelled = true
        stopRetirement()
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
        }
        reconnectTimer = null
        handleUnsubscribe?.()
        handleUnsubscribe = null
        onFrame({
          type: 'snapshot',
          messages: [],
          hasMore: false,
          error: runtimeNativeChatReadError()
        })
      })
      openStream()

      // Socket closure reaps its watcher; an unsubscribe RPC would use the wrong connection cleanup key.
      return () => {
        cancelled = true
        probe.abort()
        stopRetirement()
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
