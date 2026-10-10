// What a queued edit tells the person when its card changed or left under it, or refused a Save.

import { translate } from '@/i18n/i18n'

/** A question or approval holds the chat box's place, so the text there is out of sight until then. */
export function queuedEditNotice(
  key: 'editChanged' | 'editChangedPrompt' | 'editFailed' | 'editGone' | 'editGonePrompt'
): string {
  switch (key) {
    case 'editChanged':
      return translate(
        'components.native-chat.queuedMessages.editChanged',
        'This message changed while you were editing. Your edit is in the chat box.'
      )
    case 'editChangedPrompt':
      return translate(
        'components.native-chat.queuedMessages.editChangedPrompt',
        'This message changed while you were editing. Your edit will be in the chat box after you answer the agent.'
      )
    case 'editGone':
      return translate(
        'components.native-chat.queuedMessages.editGone',
        'This message was already sent or removed. Your edit is in the chat box.'
      )
    case 'editGonePrompt':
      return translate(
        'components.native-chat.queuedMessages.editGonePrompt',
        'This message was already sent or removed. Your edit will be in the chat box after you answer the agent.'
      )
    case 'editFailed':
      return translate(
        'components.native-chat.queuedMessages.editFailed',
        "This message can't be edited."
      )
  }
}
