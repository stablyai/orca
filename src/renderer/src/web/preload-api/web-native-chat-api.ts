import type { NativeChatApi, NativeChatAppendedMessages } from '../../../../preload/api-types'
import { buildNativeChatUnsubscribe } from '../../../../shared/native-chat-stream-unsubscribe'
import {
  parseRuntimeNativeChatReadSessionResult,
  parseRuntimeNativeChatTurnLifecycle
} from '@/components/native-chat/native-chat-runtime-contract'
import { translate } from '@/i18n/i18n'
import { callRuntimeResult } from './web-runtime-calls'
import { getClientForEnvironment, requireActiveEnvironmentOrNull } from './web-runtime-session'

export function createWebNativeChatApi(): NativeChatApi {
  return {
    readSession: async (agent, sessionId, limit, transcriptPath) =>
      parseRuntimeNativeChatReadSessionResult(
        await callRuntimeResult<unknown>('nativeChat.readSession', {
          agent,
          sessionId,
          limit,
          transcriptPath
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
            limit: args.limit
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
              const result = response.result as {
                type?: string
                messages?: NativeChatAppendedMessages
                hasMore?: boolean
                error?: string
                lifecycle?: unknown
              }
              const lifecycle = parseRuntimeNativeChatTurnLifecycle(result?.lifecycle)
              if (
                (result?.type === 'appended' ||
                  result?.type === 'snapshot' ||
                  result?.type === 'replacement') &&
                Array.isArray(result.messages)
              ) {
                if (!receivedInitial) {
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: result.messages,
                    hasMore: result.hasMore ?? result.messages.length >= (args.limit ?? 300),
                    ...(result.error ? { error: result.error } : {}),
                    ...(lifecycle ? { lifecycle } : {})
                  })
                } else if (result.type === 'snapshot') {
                  onFrame({
                    type: 'snapshot',
                    messages: result.messages,
                    hasMore: result.hasMore ?? false,
                    ...(result.error ? { error: result.error } : {}),
                    ...(lifecycle ? { lifecycle } : {})
                  })
                } else {
                  onFrame(
                    result.type === 'replacement'
                      ? {
                          type: 'replacement',
                          messages: result.messages,
                          hasMore: result.hasMore ?? false,
                          ...(lifecycle ? { lifecycle } : {})
                        }
                      : {
                          type: 'appended',
                          messages: result.messages,
                          ...(lifecycle ? { lifecycle } : {})
                        }
                  )
                }
              } else if (!receivedInitial) {
                // Why: an unrecognized ok payload never flips receivedInitial, stranding the view on 'loading'; settle it empty instead.
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
            // Why: unsubscribe reaps the fs-watcher on view-toggle (leak fix); echo the pane token so two panes don't tear down each other's watcher.
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
