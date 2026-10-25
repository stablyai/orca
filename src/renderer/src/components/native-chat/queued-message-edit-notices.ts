import { translate } from '@/i18n/i18n'

/** A question or approval holds the chat box's place, so the text there is out of sight until then. */
export function queuedEditNotice(
  key:
    | 'editChanged'
    | 'editChangedPrompt'
    | 'editChangedNotSaved'
    | 'editFailed'
    | 'editGone'
    | 'editGonePrompt'
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
    case 'editChangedNotSaved':
      return translate(
        'components.native-chat.queuedMessages.editChangedNotSaved',
        "This message changed while you were editing. Your edit wasn't saved."
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

export function queuedEditChangedNotice(handedOff: boolean, promptOpen: boolean): string {
  if (!handedOff) {
    return queuedEditNotice('editChangedNotSaved')
  }
  return queuedEditNotice(promptOpen ? 'editChangedPrompt' : 'editChanged')
}
