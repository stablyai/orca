import { translate } from '../../../../i18n/i18n'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../../../shared/file-import/native-file-drop'

export function nativeChatWorktreeNotReadyNotice(): string {
  return translate(
    'components.native-chat.composer.worktreeNotReady',
    'Worktree not ready — try again in a moment.'
  )
}

export function nativeChatAttachmentOwnerChangedNotice(): string {
  return translate(
    'components.native-chat.composer.attachmentOwnerChanged',
    'This workspace changed hosts while attaching — drop the files again.'
  )
}

export function nativeChatAttachmentUnreadableNotice(): string {
  return translate(
    'components.native-chat.composer.attachmentUnreadable',
    "Couldn't read the dropped files."
  )
}

/** Name every failed attachment and include their common cause when available. */
export function nativeChatAttachFailedNotice(names: readonly string[], cause = ''): string {
  const files = names.join(', ')
  const reason = cause.trim().replace(/[^.!?。！？]$/u, '$&.')
  return reason
    ? translate(
        'components.native-chat.composer.attachFailedBecause',
        "Couldn't attach {{files}}. {{reason}}",
        { files, reason }
      )
    : translate('components.native-chat.composer.attachFailed', "Couldn't attach {{files}}.", {
        files
      })
}

export function nativeChatTooManyAttachmentsNotice(): string {
  return translate(
    'components.native-chat.composer.tooManyAttachments',
    'Attach {{value0}} or fewer files at a time.',
    { value0: NATIVE_FILE_DROP_MAX_PATHS }
  )
}

export function nativeChatLocalAttachmentUnsupportedNotice(): string {
  return translate(
    'components.native-chat.composer.localAttachmentUnsupported',
    'Local attachments are not available for remote sessions.'
  )
}
