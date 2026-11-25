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
export type NativeChatNotesBlocked = 'unavailable' | 'editing' | 'goal' | 'command' | null

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

/** What Close says when it keeps the notes because the message box can't take them, by its reason. */
export function nativeChatNotesKeptText(
  t: Translate,
  blocked: Exclude<NativeChatNotesBlocked, null>,
  name: string
): string {
  switch (blocked) {
    case 'unavailable':
      return t(
        'components.native-chat.notes.keptNoMessageBox',
        'Notes kept with {{name}}. This chat’s message box isn’t available right now.',
        { name }
      )
    case 'editing':
      return t(
        'components.native-chat.notes.keptWhileEditing',
        'Notes kept with {{name}}. Finish editing the queued message to add them.',
        { name }
      )
    case 'goal':
      return t(
        'components.native-chat.notes.keptWhileGoal',
        'Notes kept with {{name}}. Your message box is setting a goal.',
        { name }
      )
    case 'command':
      return t(
        'components.native-chat.notes.keptWithImage',
        'Notes kept with {{name}}. Your message box holds a command.',
        { name }
      )
  }
}
