// Why handing notes off failed, and what the viewer says for each; the words stay in the viewer.

import type { Translate } from '@/i18n/use-translate'

/** Storage refused the notes: they are only in this window's memory. */
export class NativeChatNotesUnsavedError extends Error {
  constructor() {
    super('The notes could not be saved.')
  }
}

/** What the notes replace left the draft while they were prepared. */
export class NativeChatNotesSupersededError extends Error {
  constructor() {
    super('The image these notes replace is no longer in the draft.')
  }
}

/** Another viewer of the same held notes already added them to the message. */
export class NativeChatNotesAlreadyAddedError extends Error {
  constructor() {
    super('These held notes were already added from another viewer.')
  }
}

/** The media grew past what notes are drawn on since they were made (a held image changed). */
export class NativeChatNotesTooLargeError extends Error {
  constructor() {
    super('The image is too large to draw notes on.')
  }
}

/** Another viewer still has the chip these notes would replace open for editing. */
export class NativeChatNotesEditedElsewhereError extends Error {
  constructor() {
    super('The image is open for editing in another viewer.')
  }
}

/** What the viewer says when handing its notes off failed, by why; the words stay in the viewer. */
export function nativeChatNotesHandOffErrorText(t: Translate, error: unknown): string {
  if (error instanceof NativeChatNotesUnsavedError) {
    return t(
      'components.native-chat.notes.saveFailed',
      'Couldn’t save your notes. They’re still here.'
    )
  }
  if (error instanceof NativeChatNotesEditedElsewhereError) {
    return t(
      'components.native-chat.notes.editedElsewhere',
      'This image is open for editing elsewhere. Finish there first; your notes are still here.'
    )
  }
  if (error instanceof NativeChatNotesAlreadyAddedError) {
    return t(
      'components.native-chat.notes.alreadyAdded',
      'These notes were already added to your message from another window.'
    )
  }
  if (error instanceof NativeChatNotesTooLargeError) {
    return t(
      'components.native-chat.notes.annotateTooLarge',
      'This image is too large to draw notes on (over 33 megapixels).'
    )
  }
  if (error instanceof NativeChatNotesSupersededError) {
    return t(
      'components.native-chat.notes.imageChanged',
      'This image left the message box. Your notes are still here.'
    )
  }
  return t(
    'components.native-chat.notes.prepareFailed',
    'Couldn’t prepare the marked image. Your notes are still here.'
  )
}
