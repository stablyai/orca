// Why handing notes off failed, and what the viewer says for each; the words stay in the viewer.

import type { Translate } from '@/i18n/use-translate'

/** The frame to draw on is over the size notes are drawn on (a video frame can be). */
export class NativeChatNotesTooLargeError extends Error {
  constructor() {
    super('The image is too large to draw notes on.')
  }
}

/** What the viewer says when handing its notes off failed, by why; the words stay in the viewer. */
export function nativeChatNotesHandOffErrorText(t: Translate, error: unknown): string {
  if (error instanceof NativeChatNotesTooLargeError) {
    return t(
      'components.native-chat.notes.annotateTooLarge',
      'This image is too large to draw notes on (over 33 megapixels).'
    )
  }
  return t(
    'components.native-chat.notes.prepareFailed',
    'Couldn’t prepare the marked image. Your notes are still here.'
  )
}
