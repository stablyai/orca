import type { UseNativeChatLiveSessionArgs } from './native-chat-live-session-types'

export function nativeChatLiveSourceKey(args: UseNativeChatLiveSessionArgs): string {
  return JSON.stringify([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null,
    args.transcriptConnectionId ?? null
  ])
}
