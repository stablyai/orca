import type { Translate } from '@/i18n/use-translate'

/** Sources above this many pixels are view-only: drawing notes on them would hold too large a
 *  decoded image while the marked copy is made. */
export const NATIVE_CHAT_NOTES_MAX_SOURCE_PIXELS = 33_000_000

/** Why notes can't be drawn on this media, shown on its Annotate button; null when they can. */
export function nativeChatAnnotateReason(
  t: Translate,
  annotatable: boolean,
  size: { width: number; height: number } | undefined
): string | null {
  if (!annotatable) {
    return t(
      'components.native-chat.notes.annotateUnavailable',
      'Notes can’t be drawn on this image.'
    )
  }
  if (size && size.width * size.height > NATIVE_CHAT_NOTES_MAX_SOURCE_PIXELS) {
    return t(
      'components.native-chat.notes.annotateTooLarge',
      'This image is too large to draw notes on (over 33 megapixels).'
    )
  }
  return null
}

/** Why the chat's message box can't take notes now; null when it can. */
export type NativeChatNotesBlocked =
  | 'unavailable'
  | 'images'
  | 'editing'
  | 'goal'
  | 'command'
  | null

/** Why Send is off for a blocked message box. */
export function nativeChatNotesBlockedReason(
  t: Translate,
  blocked: Exclude<NativeChatNotesBlocked, null>
): string {
  switch (blocked) {
    case 'unavailable':
      return t(
        'components.native-chat.notes.noMessageBox',
        'This chat’s message box isn’t available right now.'
      )
    case 'images':
      return t(
        'components.native-chat.notes.imagesUnsupported',
        'This chat doesn’t take images, so notes can’t be added to it.'
      )
    case 'editing':
      return t(
        'components.native-chat.notes.editingQueued',
        'Finish editing the queued message first.'
      )
    case 'goal':
      return t(
        'components.native-chat.notes.goalHeld',
        'Your message box is setting a goal, which can’t include images. Finish or leave it first.'
      )
    case 'command':
      return t(
        'components.native-chat.notes.commandHeld',
        'Your message box holds a command. Send or clear it first.'
      )
  }
}

/** Why Close can't add the notes now: short, as it sits beside Discard on a narrow window too. */
export function nativeChatNotesCloseBlockedText(
  t: Translate,
  blocked: Exclude<NativeChatNotesBlocked, null>
): string {
  switch (blocked) {
    case 'unavailable':
      return t('components.native-chat.notes.closeNoMessageBox', 'No message box to add notes to.')
    case 'images':
      return t('components.native-chat.notes.closeNoImages', 'This chat takes no images.')
    case 'editing':
      return t('components.native-chat.notes.closeEditingQueued', 'Finish the queued edit first.')
    case 'goal':
      return t('components.native-chat.notes.closeGoal', 'Goals can’t include images.')
    case 'command':
      return t('components.native-chat.notes.closeCommand', 'Message box has a command.')
  }
}
