import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { showNativeChatNotesNotice } from './native-chat-notes-notice'
import {
  nativeChatNotesBlockedReason,
  nativeChatNotesKeptText,
  type NativeChatNotesBlocked
} from './native-chat-notes-reasons'
import { NATIVE_CHAT_NOTES_ERROR_ID } from './NativeChatMediaNotesPanel'
import { useTranslate } from '@/i18n/use-translate'
import type { PanZoomSize } from '../../../../../../shared/document-preview/pan-zoom-view'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import type { NativeChatNotesSource } from './native-chat-attachment-notes'
import type { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import {
  afterComposerRender,
  announceNativeChatNotesHandOff,
  attachNativeChatNotes,
  nativeChatNotesComposer,
  nativeChatNotesScopeKey,
  nativeChatNotesStillInDraft,
  NativeChatNotesSupersededError,
  settleNativeChatNotesReplacement,
  captureNativeChatNotesSend,
  submitNativeChatNotesIfApproved,
  NativeChatNotesUnsavedError,
  type NativeChatNotesComposer
} from './native-chat-notes-handoff'
import {
  holdNativeChatNotes,
  nativeChatNotesMediaKey,
  claimHeldNativeChatNotes,
  readHeldNativeChatNotes,
  releaseHeldNativeChatNotes,
  handOffHeldNativeChatNotes,
  type NativeChatHeldNotesClaim
} from './native-chat-held-notes'

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
  loaded: { size: PanZoomSize; image: HTMLImageElement } | null
  editor: Editor
  title: string
  source: NativeChatNotesSource
  offset: number
  initialNotes: readonly NativeChatMediaNote[] | undefined
  /** The marked images now in the draft. A returned function undoes what the caller replaced
   *  (a reopened chip goes back as it was); without one, Undo holds the notes with the media.
   *  False: what they replace is gone from the draft, so they are taken back out. */
  onAttached: ((ids: string[]) => (() => boolean | void) | void | false) | undefined
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
  const mediaKey = nativeChatNotesMediaKey(source, title)
  const [busy, setBusy] = useState(false)
  // One hand-off at a time: Esc or × while Send is still preparing must not start a second one.
  const busyRef = useRef(false)
  // The message box lives outside the viewer: looked up once the viewer and its image are on screen.
  const [composer, setComposer] = useState<NativeChatNotesComposer | null>(null)
  const restored = useRef(false)
  // The chat whose held notes this viewer brought back: they stay held until handed off or removed.
  const heldIn = useRef<NativeChatHeldNotesClaim | null>(null)
  useLayoutEffect(() => {
    const found = nativeChatNotesComposer(opener.current)
    setComposer(found)
    // Notes held in this chat for this media come back once, when its chat is known.
    if (found && !restored.current && !initialNotes) {
      restored.current = true
      const held = readHeldNativeChatNotes(found.scopeKey, mediaKey)
      if (held?.length) {
        heldIn.current = claimHeldNativeChatNotes(found.scopeKey, mediaKey)
        editor.restore(held)
        onRestored()
      }
    }
  }, [editor, initialNotes, loaded, mediaKey, onRestored, opener])
  const showError = useCallback(
    (message: string): void => {
      editor.setStatus({ kind: 'error', message })
      // The failure is shown where the notes are: back to annotating, the panel open, the error focused.
      onRestored()
      showPanel()
      requestAnimationFrame(() => document.getElementById(NATIVE_CHAT_NOTES_ERROR_ID)?.focus())
    },
    [editor, onRestored, showPanel]
  )
  const unsavedMessage = t(
    'components.native-chat.notes.saveFailed',
    'Couldn’t save your notes. They’re still here.'
  )
  // A message box that can't say (no notesBlocked) is treated as holding a command; null means admitted.
  const blocked: NativeChatNotesBlocked = !composer
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
    : blocked !== null
      ? nativeChatNotesBlockedReason(t, blocked)
      : includesMessage
        ? t('components.native-chat.notes.includesMessage', 'Includes your message')
        : null
  // Until the image is read there is nothing to draw the marks on, so Send waits for it.
  const canSend =
    notes.length > 0 &&
    !editor.hasUnadded &&
    !editor.confirm &&
    admitted &&
    !busy &&
    Boolean(composer && loaded)

  const handOff = useCallback(
    async (send: boolean): Promise<boolean> => {
      if (!composer || !loaded || notes.length === 0 || busyRef.current) {
        return false
      }
      busyRef.current = true
      // Send goes to this message box with this draft, as they are now, or not at all.
      const approved = send ? captureNativeChatNotesSend(opener, composer) : null
      setBusy(true)
      // The image is drawn from these notes: no change to them until it is handed off or fails.
      editor.setLocked(true)
      let handed = false
      try {
        const ids = await attachNativeChatNotes({
          composer,
          mediaName: title,
          kind: 'image',
          source,
          notes,
          offset,
          frame: async () => ({ image: loaded.image, ...loaded.size })
        })
        const restore = settleNativeChatNotesReplacement(composer.scopeKey, ids, onAttached?.(ids))
        handed = true
        if (heldIn.current) {
          // The hold ends once the draft holding the marked image is saved, not before.
          void handOffHeldNativeChatNotes(heldIn.current, ids)
          heldIn.current = null
        }
        if (approved) {
          await afterComposerRender()
          submitNativeChatNotesIfApproved(approved, ids, replacesAttachmentId)
          await afterComposerRender()
        }
        // Sent, the images have left the draft; when the box held the send back, say where they are.
        if (!send || nativeChatNotesStillInDraft(composer.scopeKey, ids)) {
          announceNativeChatNotesHandOff(
            composer.scopeKey,
            ids,
            // What was there before comes back first; the new pair goes only once that is saved.
            () => {
              if (
                restore
                  ? restore() !== false
                  : holdNativeChatNotes(composer.scopeKey, mediaKey, notes)
              ) {
                return true
              }
              showNativeChatNotesNotice(composer.scopeKey, {
                text: t(
                  'components.native-chat.notes.undoUnsaved',
                  'Couldn’t undo: the earlier notes couldn’t be saved. These stay in your message.'
                )
              })
              return false
            },
            notes.length
          )
        }
      } catch (error) {
        console.error('[native-chat] notes hand-off failed', error)
        showError(
          error instanceof NativeChatNotesUnsavedError
            ? unsavedMessage
            : error instanceof NativeChatNotesSupersededError
              ? t(
                  'components.native-chat.notes.imageChanged',
                  'This image left the message box. Your notes are still here.'
                )
              : t(
                  'components.native-chat.notes.prepareFailed',
                  'Couldn’t prepare the marked image. Your notes are still here.'
                )
        )
      }
      busyRef.current = false
      setBusy(false)
      editor.setLocked(false)
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
      opener,
      replacesAttachmentId,
      showError,
      source,
      t,
      title,
      unsavedMessage
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
    if (notes.length > 0 && !initialNotes && (!admitted || !loaded) && scopeKey) {
      // A command waits in the message box, or the image isn't read yet: the notes stay with this
      // chat and media for later. Closing waits until storage has them.
      if (!holdNativeChatNotes(scopeKey, mediaKey, notes)) {
        showError(unsavedMessage)
        return
      }
      if (blocked !== null) {
        showNativeChatNotesNotice(scopeKey, { text: nativeChatNotesKeptText(t, blocked, title) })
      }
    } else if (notes.length === 0 && heldIn.current) {
      // Every held note was removed: the hold ends with them.
      releaseHeldNativeChatNotes(heldIn.current)
      heldIn.current = null
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
