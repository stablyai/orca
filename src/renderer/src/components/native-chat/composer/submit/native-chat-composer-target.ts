import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

export type NativeChatResolvedTarget = {
  ptyId: string
}

/** After Stop, use a queue card or a direct send held by the host until settlement. */
export type NativeChatAfterStopSend = 'queue' | 'send'

export function nativeChatComposerTargetIsRemote(ptyId: string | null): boolean {
  return ptyId !== null && isRemoteRuntimePtyId(ptyId)
}
