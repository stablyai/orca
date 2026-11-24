import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function formatAttachmentPreviewError(message: string, t: Translate = translate): string {
  switch (message) {
    case 'Unreadable attachment reply. Try again.':
      return t(
        'components.native-chat.textAttachmentPreview.unreadableReply',
        'Unreadable attachment reply. Try again.'
      )
    case 'Attachment changed or its reply was incomplete. Close it and try again.':
      return t(
        'components.native-chat.textAttachmentPreview.incompleteReply',
        'Attachment changed or its reply was incomplete. Close it and try again.'
      )
    case 'This file cannot be previewed as text. Save it to open it in another app.':
      return t(
        'components.native-chat.textAttachmentPreview.notText',
        'This file cannot be previewed as text. Save it to open it in another app.'
      )
    case 'Unable to open attachment. Try again.':
      return t(
        'components.native-chat.textAttachmentPreview.openFailed',
        'Unable to open attachment. Try again.'
      )
    case 'This host cannot open text attachments yet. Update Orca on that host, then retry.':
      return t(
        'components.native-chat.textAttachmentPreview.hostUpdate',
        'This host cannot open text attachments yet. Update Orca on that host, then retry.'
      )
    case 'This file is too large to copy. Save it instead.':
      return t(
        'components.native-chat.textAttachmentPreview.copyTooLarge',
        'This file is too large to copy. Save it instead.'
      )
    case 'The attachment host is unavailable. Reconnect and retry.':
      return t(
        'components.native-chat.textAttachmentPreview.hostUnavailable',
        'The attachment host is unavailable. Reconnect and retry.'
      )
    case 'Connection changed. Close this attachment and reopen it.':
      return t(
        'components.native-chat.textAttachmentPreview.connectionChanged',
        'Connection changed. Close this attachment and reopen it.'
      )
    case 'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.':
      return t(
        'components.native-chat.textAttachmentPreview.readFailed',
        'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.'
      )
    case 'Unable to export attachment. Try again.':
      return t(
        'components.native-chat.textAttachmentPreview.exportError',
        'Unable to export attachment. Try again.'
      )
    default:
      return message
  }
}
