import type { NativeChatApi } from '../../../../preload/api-types'
import {
  RUNTIME_NATIVE_CHAT_READ_ERROR,
  RUNTIME_NATIVE_CHAT_TOO_OLD
} from './native-chat-runtime-contract'

type Transport = Pick<NativeChatApi, 'readSession' | 'subscribe'>

/** An older host cannot decode agy; distinguish that from a transcript awaiting its first write. */
export function guardAntigravityChatTransport(
  transport: Transport,
  supports: () => Promise<boolean>
): Transport {
  const errorForHost = async (): Promise<string | null> => {
    try {
      return (await supports()) ? null : RUNTIME_NATIVE_CHAT_TOO_OLD
    } catch {
      return RUNTIME_NATIVE_CHAT_READ_ERROR
    }
  }
  return {
    readSession: async (agent, ...args) => {
      const error = agent === 'antigravity' ? await errorForHost() : null
      return error ? { error } : transport.readSession(agent, ...args)
    },
    subscribe: (args, onFrame) => {
      if (args.agent !== 'antigravity') {
        return transport.subscribe(args, onFrame)
      }
      let cancelled = false
      let unsubscribe: (() => void) | undefined
      void errorForHost()
        .then(async (error) => {
          if (cancelled) {
            return
          }
          if (error) {
            onFrame({ type: 'snapshot', messages: [], hasMore: false, error })
            return
          }
          const stop = await Promise.resolve(
            transport.subscribe(args, (frame) => {
              if (!cancelled) {
                onFrame(frame)
              }
            })
          )
          if (cancelled) {
            stop()
          } else {
            unsubscribe = stop
          }
        })
        .catch(() => {
          if (!cancelled) {
            onFrame({
              type: 'snapshot',
              messages: [],
              hasMore: false,
              error: RUNTIME_NATIVE_CHAT_READ_ERROR
            })
          }
        })
      return () => {
        cancelled = true
        unsubscribe?.()
      }
    }
  }
}
