import type { NativeChatApi } from '../../../../../preload/api/native-chat/native-chat-api'
import { buildNativeChatUnsubscribe } from '../../../../../shared/native-chat/transcript/streaming/native-chat-stream-unsubscribe'
import { parseTranscriptRangeVerification } from '../../../../../shared/native-chat/transcript/transcript-byte-range'
import {
  parseRuntimeNativeChatReadSessionResult,
  parseRuntimeNativeChatFrame,
  parseTranscriptByteRanges,
  parseRuntimeNativeChatTurnLifecycle
} from '@/components/native-chat/session/terminal/read/native-chat-runtime-contract'
import {
  unwrapRuntimeRpcResult,
  RuntimeRpcCallError
} from '../../../runtime/rpc/calls/runtime-rpc-result'
import { translate } from '@/i18n/i18n'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'
import {
  getClientForEnvironment,
  requireActiveEnvironmentOrNull
} from '../../runtime/client/web-runtime-session'

export function createWebNativeChatApi(): NativeChatApi {
  const verifications = new Map<string, AbortController>()
  return {
    cancelTranscriptRangeVerification: (requestId) => {
      verifications.get(requestId)?.abort()
    },
    verifyTranscriptRanges: async (agent, sessionId, ranges, transcriptPath, requestId) => {
      const controller = new AbortController()
      const { signal } = controller
      const environment = requireActiveEnvironmentOrNull()
      if (!environment) {
        return null
      }
      verifications.set(requestId, controller)
      try {
        const result = unwrapRuntimeRpcResult(
          await getClientForEnvironment(environment).call(
            'nativeChat.verifyTranscriptRanges',
            { agent, sessionId, ranges, transcriptPath },
            { signal, timeoutMs: 120_000 }
          )
        )
        return parseTranscriptRangeVerification(result)
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
          return null
        }
        throw error
      } finally {
        verifications.delete(requestId)
      }
    },
    // The full output stays on the host that ran the agent; the web client shows the message.
    getConversationNameFailureOutput: async () => null,
    readSession: async (agent, sessionId, limit, transcriptPath, options) =>
      parseRuntimeNativeChatReadSessionResult(
        await callRuntimeResult<unknown>('nativeChat.readSession', {
          agent,
          sessionId,
          limit,
          transcriptPath,
          beforeOffset: options?.beforeOffset,
          capabilities: { transcriptSourceOrder: 1 }
        })
      ),
    subscribe: (args, onFrame) => {
      // No paired runtime yet: return a no-op teardown so the chat view mounts cleanly; only the not-paired case is swallowed.
      const environment = requireActiveEnvironmentOrNull()
      if (!environment) {
        onFrame({
          type: 'snapshot',
          messages: [],
          hasMore: false,
          error: translate(
            'components.native-chat.state.pairHost',
            'Pair a host to view agent chat history.'
          )
        })
        return () => {}
      }
      let handle: { unsubscribe: () => void } | null = null
      let cancelled = false
      let receivedInitial = false
      void getClientForEnvironment(environment)
        .subscribe(
          'nativeChat.subscribe',
          {
            agent: args.agent,
            sessionId: args.sessionId,
            subscriptionId: args.subscriptionId,
            transcriptPath: args.transcriptPath,
            limit: args.limit,
            capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
          },
          {
            onResponse: (response) => {
              if (cancelled) {
                return
              }
              if (!response.ok) {
                if (!receivedInitial) {
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: [],
                    hasMore: false,
                    error: response.error.message
                  })
                }
                return
              }
              const result = parseRuntimeNativeChatFrame(response.result)
              const lifecycle = parseRuntimeNativeChatTurnLifecycle(result?.lifecycle)
              // No transcript behind this window yet — forwarded so the view can stop spinning, but it is not the settled initial read.
              const pending = result?.pending === true
              if (
                (result?.type === 'appended' ||
                  result?.type === 'snapshot' ||
                  result?.type === 'replacement') &&
                Array.isArray(result.messages)
              ) {
                if (!receivedInitial) {
                  if (!pending) {
                    receivedInitial = true
                  }
                  onFrame({
                    type: 'snapshot',
                    messages: result.messages,
                    ranges: parseTranscriptByteRanges(result.ranges),
                    hasMore: result.hasMore ?? result.messages.length >= (args.limit ?? 300),
                    ...(result.error ? { error: result.error } : {}),
                    ...(lifecycle ? { lifecycle } : {}),
                    ...(pending ? { pending: true } : {})
                  })
                } else if (result.type === 'snapshot') {
                  onFrame({
                    type: 'snapshot',
                    messages: result.messages,
                    ranges: parseTranscriptByteRanges(result.ranges),
                    hasMore: result.hasMore ?? false,
                    ...(result.error ? { error: result.error } : {}),
                    ...(lifecycle ? { lifecycle } : {}),
                    ...(pending ? { pending: true } : {})
                  })
                } else {
                  onFrame(
                    result.type === 'replacement'
                      ? {
                          type: 'replacement',
                          messages: result.messages,
                          ranges: parseTranscriptByteRanges(result.ranges),
                          hasMore: result.hasMore ?? false,
                          ...(lifecycle ? { lifecycle } : {})
                        }
                      : {
                          type: 'appended',
                          messages: result.messages,
                          ranges: parseTranscriptByteRanges(result.ranges),
                          ...(lifecycle ? { lifecycle } : {})
                        }
                  )
                }
              } else if (!receivedInitial) {
                // Unknown ok payloads otherwise never set receivedInitial, leaving the view loading forever.
                receivedInitial = true
                onFrame({
                  type: 'snapshot',
                  messages: [],
                  hasMore: false,
                  ...(result?.error ? { error: result.error } : {})
                })
              }
            }
          },
          {
            // Unsubscribe reaps the watcher on view toggle; pane tokens prevent cross-pane teardown.
            buildUnsubscribe: () =>
              buildNativeChatUnsubscribe(args.agent, args.sessionId, args.subscriptionId)
          }
        )
        .then((h) => {
          if (cancelled) {
            h.unsubscribe()
          } else {
            handle = h
          }
        })
        .catch((err: unknown) => {
          if (!cancelled && !receivedInitial) {
            receivedInitial = true
            onFrame({
              type: 'snapshot',
              messages: [],
              hasMore: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        })
      return () => {
        cancelled = true
        handle?.unsubscribe()
      }
    }
  }
}
