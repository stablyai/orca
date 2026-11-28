// Why handing notes off failed, and what the viewer says for each; the words stay in the viewer.

import type { Translate } from '@/i18n/use-translate'
import { NativeChatGeneratedImageRefusedError } from '../../paste/use-native-chat-generated-image-attach'
import {
  nativeChatNotesBlockedReason,
  nativeChatNotesCloseBlockedText,
  type NativeChatNotesBlocked
} from './native-chat-notes-reasons'

/** The frame to draw on is over the size notes are drawn on (a video frame can be). */
export class NativeChatNotesTooLargeError extends Error {
  constructor() {
    super('The image is too large to draw notes on.')
  }
}

/** The message box stopped taking notes while they were being added; nothing was kept there. */
export class NativeChatNotesBlockedError extends Error {
  constructor(readonly blocked: Exclude<NativeChatNotesBlocked, null>) {
    super(`The message box can't take notes now (${blocked}).`)
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
  if (error instanceof NativeChatNotesBlockedError) {
    return nativeChatNotesBlockedReason(t, error.blocked)
  }
  // Why the chat can't take the image (its worktree isn't ready, a remote session…), said once, here.
  if (error instanceof NativeChatGeneratedImageRefusedError) {
    return error.message
  }
  return t(
    'components.native-chat.notes.prepareFailed',
    'Couldn’t prepare the marked image. Your notes are still here.'
  )
}

/** The same, for Close, where it sits beside Discard: short, so a refused image reads as not added. */
export function nativeChatNotesCloseErrorText(t: Translate, error: unknown): string {
  if (error instanceof NativeChatNotesBlockedError) {
    return nativeChatNotesCloseBlockedText(t, error.blocked)
  }
  return error instanceof NativeChatNotesTooLargeError
    ? t('components.native-chat.notes.closeTooLarge', 'Too large to draw notes on.')
    : t('components.native-chat.notes.closeFailed', 'Couldn’t add the marked image.')
}
