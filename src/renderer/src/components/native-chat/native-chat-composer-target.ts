import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_COMPOSER_PLACEHOLDER,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../../shared/native-chat-turn-status'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

export type NativeChatResolvedTarget = {
  ptyId: string
}

/** Bound clipboard text so a pathological payload cannot stall IPC. */
export const NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES = 16 * 1024 * 1024

/** After Stop, use a queue card or a direct send held by the host until settlement. */
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
  return translate('components.native-chat.composer.placeholder', NATIVE_CHAT_COMPOSER_PLACEHOLDER)
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
