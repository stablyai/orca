import { createRuntimeNativeChatTransport } from './native-chat-runtime-transport'
export {
  RUNTIME_NATIVE_CHAT_RECONNECT_MS,
  toRuntimeNativeChatErrorMessage
} from './native-chat-runtime-transport'
import type { NativeChatApi } from '../../../../preload/api-types'
import { createWebNativeChatApi } from '@/web/preload-api/web-native-chat-api'
import {
  requireActiveEnvironmentOrNull,
  resolveEnvironment
} from '@/web/preload-api/web-runtime-session'
import { isWebClientLocation } from '@/lib/web-client-location'

/** Match local IPC so session consumers can read local or runtime-owned transcripts. */
export type NativeChatSessionTransport = Pick<
  NativeChatApi,
  'readSession' | 'subscribe' | 'cancelCurrentQuestions'
> & {
  currentRequests: (
    request: Parameters<NativeChatApi['currentRequests']>[0],
    signal?: AbortSignal
  ) => ReturnType<NativeChatApi['currentRequests']>
}

/** Web IPC already targets its paired runtime; preserve sync desktop and deferred web teardown forms. */
const localNativeChatTransport: NativeChatSessionTransport = {
  cancelCurrentQuestions: (request) => window.api.nativeChat.cancelCurrentQuestions(request),
  currentRequests: (request) => window.api.nativeChat.currentRequests(request),
  readSession: (agent, sessionId, limit, transcriptPath) =>
    window.api.nativeChat.readSession(agent, sessionId, limit, transcriptPath),
  subscribe: (args, onFrame) => window.api.nativeChat.subscribe(args, onFrame)
}

/** Only desktop runtime-owned panes need this adapter; web and local/SSH panes keep the IPC bridge. */
export function getNativeChatSessionTransport(
  runtimeEnvironmentId: string | null
): NativeChatSessionTransport {
  if (isWebClientLocation()) {
    return createWebNativeChatApi({
      environment: runtimeEnvironmentId
        ? resolveEnvironment(runtimeEnvironmentId)
        : requireActiveEnvironmentOrNull()
    })
  }
  if (runtimeEnvironmentId) {
    return createRuntimeNativeChatTransport(runtimeEnvironmentId)
  }
  return localNativeChatTransport
}

export function messageCancelAction(
  transport: NativeChatSessionTransport,
  agent: Parameters<NativeChatApi['readSession']>[0],
  sessionId: string | null,
  transcriptPath?: string | null
): (ids: readonly string[]) => Promise<void> {
  return async (ids) => {
    if (!sessionId) {
      throw new Error('Chat source unavailable')
    }
    await transport.cancelCurrentQuestions({
      agent,
      sessionId,
      ...(transcriptPath ? { transcriptPath } : {}),
      ids: [...ids]
    })
  }
}
