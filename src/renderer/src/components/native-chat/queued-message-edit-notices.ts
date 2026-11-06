import { translate } from '@/i18n/i18n'
import {
  QUEUED_EDIT_NOTICE_COPY as COPY,
  type QueuedEditNotice
} from '../../../../shared/queued-message-edit'

const NOTICES: Record<QueuedEditNotice, () => string> = {
  editChanged: () =>
    translate('components.native-chat.queuedMessages.editChanged', COPY.editChanged),
  editChangedPrompt: () =>
    translate('components.native-chat.queuedMessages.editChangedPrompt', COPY.editChangedPrompt),
  editChangedNotSaved: () =>
    translate(
      'components.native-chat.queuedMessages.editChangedNotSaved',
      COPY.editChangedNotSaved
    ),
  editGone: () => translate('components.native-chat.queuedMessages.editGone', COPY.editGone),
  editGonePrompt: () =>
    translate('components.native-chat.queuedMessages.editGonePrompt', COPY.editGonePrompt),
  editFailed: () => translate('components.native-chat.queuedMessages.editFailed', COPY.editFailed)
}

export function queuedEditNotice(key: QueuedEditNotice): string {
  return NOTICES[key]()
}
