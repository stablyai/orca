import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../../shared/native-chat-turn-status'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'

export type NativeChatResolvedTarget = {
  ptyId: string
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>
}

/** Upper bound for clipboard text pulled into the composer via Cmd/Ctrl+V, so a
 *  pathological clipboard can't stall the round-trip. */
export const NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES = 16 * 1024 * 1024

/** How a message sent while the chat reads Stopping goes out: as a queued card, or sent for the
 *  host to hold until the stop lands. */
export type NativeChatAfterStopSend = 'queue' | 'send'

export function nativeChatComposerPlaceholder(
  hasPty: boolean,
  canSend: boolean,
  afterStop?: NativeChatAfterStopSend
): string {
  if (!hasPty) {
    return translate(
      'components.native-chat.composer.noPty',
      'No live terminal — toggle back to reconnect.'
    )
  }
  if (!canSend) {
    return translate('components.native-chat.composer.locked', 'Input is held by another device.')
  }
  if (afterStop === 'queue') {
    return translate(
      'components.native-chat.status.queueAfterStop',
      NATIVE_CHAT_TURN_STATUS_COPY.queueAfterStop
    )
  }
  if (afterStop === 'send') {
    return translate(
      'components.native-chat.status.sendAfterStop',
      NATIVE_CHAT_TURN_STATUS_COPY.sendAfterStop
    )
  }
  return translate(
    'components.native-chat.composer.placeholder',
    'Ask anything, @ to mention files, / for commands'
  )
}

export function nativeChatComposerTargetIsRemote(ptyId: string | null): boolean {
  return ptyId !== null && isRemoteRuntimePtyId(ptyId)
}

export function nativeChatLocalAttachmentUnsupportedNotice(): string {
  return translate(
    'components.native-chat.composer.localAttachmentUnsupported',
    'Local attachments are not available for remote sessions.'
  )
}

export { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
