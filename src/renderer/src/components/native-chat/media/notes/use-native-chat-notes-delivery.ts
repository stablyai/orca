import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import {
  NativeChatVideoFrameUnavailable,
  nativeChatVideoNotesAsText
} from './video/use-native-chat-video-frames'
import { showNativeChatNotesNotice } from './native-chat-notes-notice'
import { NATIVE_CHAT_NOTES_ERROR_ID } from './NativeChatMediaNotesPanel'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import type { NativeChatNotesSource } from './native-chat-attachment-notes'
import type { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import {
  afterComposerRender,
  attachNativeChatNotes,
  detachNativeChatNotes,
  nativeChatNotesComposer,
  nativeChatNotesScopeKey,
  nativeChatNotesStillInDraft,
  watchNativeChatNotesLeaveDraft,
  type NativeChatMediaLoaded,
  type NativeChatNotesComposer
} from './native-chat-notes-handoff'
import { holdNativeChatNotes, takeHeldNativeChatNotes } from './native-chat-held-notes'

type Editor = ReturnType<typeof useNativeChatNotesEditor>

/** Getting a viewer's notes to its chat: Send, the hand-off on close (with Undo), and notes held
 *  while the message box holds a command. */
export function useNativeChatNotesDelivery({
  opener,
  loaded,
  editor,
  title,
  source,
  offset,
  initialNotes,
  onAttached,
  onCleared,
  replacesAttachmentId,
  onOpenChange,
  showPanel,
  onRestored
}: {
  opener: React.RefObject<Element | null>
  loaded: NativeChatMediaLoaded | null
  editor: Editor
  title: string
  source: NativeChatNotesSource
  offset: number
  initialNotes: readonly NativeChatMediaNote[] | undefined
  /** The marked images now in the draft. A returned function undoes what the caller replaced
   *  (a reopened chip goes back as it was); without one, Undo holds the notes with the media. */
  onAttached: ((ids: string[]) => (() => void) | void) | undefined
  /** A reopened marked image whose notes were all deleted: the caller takes them out of the draft
   *  and returns what puts them back. */
  onCleared?: () => () => void
  /** The draft image these notes replace (a reopened or annotated chip), not part of "your message". */
  replacesAttachmentId?: string
  onOpenChange: (open: boolean) => void
  /** Brings the notes panel back, for a question the user must answer there. */
  showPanel: () => void
  /** Notes need the user again (held notes came back, or a hand-off failed): resume annotating. */
  onRestored: () => void
}) {
  const t = useTranslate()
  const { notes } = editor
  const mediaKey = source.path ?? source.url ?? title
  const [busy, setBusy] = useState(false)
  // One hand-off at a time: Esc or × while Send is still preparing must not start a second one.
  const busyRef = useRef(false)
  // The message box lives outside the viewer: looked up once the viewer and its image are on screen.
  const [composer, setComposer] = useState<NativeChatNotesComposer | null>(null)
  const restored = useRef(false)
  useLayoutEffect(() => {
    const found = nativeChatNotesComposer(opener.current)
    setComposer(found)
    // Notes held in this chat for this media come back once, when its chat is known.
    if (found && !restored.current && !initialNotes) {
      restored.current = true
      const held = takeHeldNativeChatNotes(found.scopeKey, mediaKey)
      if (held?.length) {
        editor.restore(held)
        onRestored()
      }
    }
  }, [editor, initialNotes, loaded, mediaKey, onRestored, opener])
  // A message box that can't say (no notesBlocked) is treated as holding a command; null means admitted.
  const blocked = !composer
    ? 'unavailable'
    : composer.handle.notesBlocked
      ? composer.handle.notesBlocked()
      : 'command'
  const admitted = blocked === null
  // Send in the viewer sends the whole message: say so when the box already holds more than these notes.
  const draft = composer ? readNativeChatComposerDraft(composer.scopeKey) : null
  const includesMessage =
    draft !== null &&
    (draft.text.trim() !== '' || draft.images.some(({ id }) => id !== replacesAttachmentId))
  const sendReason = editor.hasUnadded
    ? t('components.native-chat.notes.addFirst', 'Add or discard note {{number}} first', {
        number: editor.pending?.number ?? editor.editing?.number ?? 0
      })
    : blocked === 'unavailable'
      ? t(
          'components.native-chat.notes.noMessageBox',
          'This chat’s message box isn’t available right now.'
        )
      : blocked === 'editing'
        ? t(
            'components.native-chat.notes.editingQueued',
            'Finish editing the queued message first.'
          )
        : blocked === 'command'
          ? t(
              'components.native-chat.notes.commandHeld',
              'Your message box holds a command. Send or clear it first.'
            )
          : includesMessage
            ? t('components.native-chat.notes.includesMessage', 'Includes your message')
            : null
  // Until the image is read there is nothing to draw the marks on, so Send waits for it.
  const canSend =
    notes.length > 0 && !editor.hasUnadded && admitted && !busy && Boolean(composer && loaded)

  const handOff = useCallback(
    async (send: boolean): Promise<boolean> => {
      if (!composer || !loaded || notes.length === 0 || busyRef.current) {
        return false
      }
      busyRef.current = true
      setBusy(true)
      let handed = false
      try {
        const ids = await attachNativeChatNotes({
          composer,
          mediaName: title,
          kind: loaded.kind,
          source,
          notes,
          offset,
          frame: loaded.frame
        })
        const restore = onAttached?.(ids) ?? undefined
        handed = true
        if (send) {
          await afterComposerRender()
          composer.handle.submit?.()
          await afterComposerRender()
        }
        // Sent, the images have left the draft; when the box held the send back, say where they are.
        if (!send || nativeChatNotesStillInDraft(composer.scopeKey, ids)) {
          announceNativeChatNotesHandOff(
            composer.scopeKey,
            ids,
            () => {
              if (restore) {
                restore()
              } else {
                holdNativeChatNotes(composer.scopeKey, mediaKey, notes)
              }
            },
            notes.length
          )
        }
      } catch (error) {
        if (error instanceof NativeChatVideoFrameUnavailable) {
          // Option B: a frame of a recording with no known length is gone after a restart. The
          // words still go to the message, as text; only the drawn marks are lost.
          appendToNativeChatComposerDraft(composer.scopeKey, {
            text: nativeChatVideoNotesAsText(title, notes)
          })
          showNativeChatNotesNotice(composer.scopeKey, {
            text: t(
              'components.native-chat.notes.addedAsText',
              'Notes added as text: this video’s frames can’t be shown again.'
            )
          })
          busyRef.current = false
          setBusy(false)
          return true
        }
        editor.setStatus({
          kind: 'error',
          message: t(
            'components.native-chat.notes.prepareFailed',
            'Couldn’t prepare the marked image. Your notes are still here.'
          )
        })
        console.error('[native-chat] notes hand-off failed', error)
        // The failure is shown where the notes are: back to annotating, the panel open, the error focused.
        onRestored()
        showPanel()
        requestAnimationFrame(() => document.getElementById(NATIVE_CHAT_NOTES_ERROR_ID)?.focus())
      }
      busyRef.current = false
      setBusy(false)
      return handed
    },
    [
      composer,
      editor,
      loaded,
      mediaKey,
      notes,
      offset,
      onAttached,
      onRestored,
      showPanel,
      source,
      t,
      title
    ]
  )

  const close = async (): Promise<void> => {
    if (busyRef.current) {
      return
    }
    if (editor.hasUnadded) {
      showPanel()
      editor.setConfirm({ reason: 'close' })
      return
    }
    const scopeKey = composer?.scopeKey ?? nativeChatNotesScopeKey(opener.current)
    if (initialNotes?.length && notes.length === 0 && onCleared && scopeKey) {
      const putBack = onCleared()
      showNativeChatNotesNotice(scopeKey, {
        text: t('components.native-chat.notes.notesRemoved', '{{count}} notes removed', {
          defaultValue_one: '{{count}} note removed',
          count: initialNotes.length
        }),
        undo: putBack
      })
      onOpenChange(false)
      return
    }
    if (notes.length > 0 && !initialNotes && !admitted && scopeKey) {
      // A command waits in the message box: the notes stay with this chat and media for later.
      holdNativeChatNotes(scopeKey, mediaKey, notes)
      showNativeChatNotesNotice(scopeKey, {
        text: t(
          'components.native-chat.notes.keptWithImage',
          'Notes kept with {{name}}. Your message box holds a command.',
          { name: title }
        )
      })
      // Before the image is read its notes are unchanged, so closing then leaves them where they were.
    } else if (notes.length > 0 && loaded && !(await handOff(false))) {
      return
    }
    onOpenChange(false)
  }
  const send = async (): Promise<void> => {
    if (canSend && (await handOff(true))) {
      onOpenChange(false)
    }
  }
  return { busy, canSend, sendReason, close, send }
}

/** "N notes added to your message" with Undo in the message box, live only while those images are
 *  still in the draft. */
function announceNativeChatNotesHandOff(
  scopeKey: string,
  ids: string[],
  undo: () => void,
  count: number
): void {
  const dismiss = showNativeChatNotesNotice(scopeKey, {
    text: translate(
      'components.native-chat.notes.addedToMessage',
      '{{count}} notes added to your message',
      { defaultValue_one: '{{count}} note added to your message', count }
    ),
    undo: () => {
      if (nativeChatNotesStillInDraft(scopeKey, ids)) {
        detachNativeChatNotes(scopeKey, ids)
        undo()
      }
    }
  })
  watchNativeChatNotesLeaveDraft(scopeKey, ids, dismiss)
}
