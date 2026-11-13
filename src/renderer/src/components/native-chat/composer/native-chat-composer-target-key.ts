import type { NativeChatStructuredComposerTransport } from './submit/native-chat-structured-composer-transport'

/** The pane, terminal and structured session this composer sends to. */
export function nativeChatComposerTargetKey(
  paneKey: string,
  targetPtyId: string | null,
  structuredTransport: NativeChatStructuredComposerTransport | undefined
): string {
  return JSON.stringify([
    paneKey,
    targetPtyId,
    structuredTransport?.sessionId,
    structuredTransport?.worktreeId,
    structuredTransport?.runtimeEnvironmentId
  ])
}
