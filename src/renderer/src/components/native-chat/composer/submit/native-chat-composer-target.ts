import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { NativeChatComposerProps } from '../native-chat-composer-types'

export type NativeChatResolvedTarget = {
  ptyId: string
}

export function nativeChatComposerTargetKey(
  paneKey: string,
  targetPtyId: string | null,
  transport: NativeChatComposerProps['structuredTransport']
): string {
  return JSON.stringify([
    paneKey,
    targetPtyId,
    transport?.sessionId,
    transport?.worktreeId,
    transport?.runtimeEnvironmentId
  ])
}

/** After Stop, use a queue card or a direct send held by the host until settlement. */
export type NativeChatAfterStopSend = 'queue' | 'send'

export function nativeChatComposerTargetIsRemote(ptyId: string | null): boolean {
  return ptyId !== null && isRemoteRuntimePtyId(ptyId)
}
