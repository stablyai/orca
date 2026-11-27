import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import {
  nativeChatNotesBlockedReason,
  type NativeChatNotesBlocked
} from './native-chat-notes-reasons'
import { NATIVE_CHAT_NOTES_ERROR_ID } from './NativeChatMediaNotesPanel'
import { useTranslate } from '@/i18n/use-translate'
import type { PanZoomSize } from '../../../../../../shared/document-preview/pan-zoom-view'
import type { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import {
  afterComposerRender,
  announceNativeChatNotesHandOff,
  attachNativeChatNotes,
  captureNativeChatNotesSend,
  nativeChatNotesComposer,
  nativeChatNotesHandOffErrorText,
  nativeChatNotesStillInDraft,
  submitNativeChatNotesIfApproved,
  type NativeChatNotesComposer
} from './native-chat-notes-handoff'

type Editor = ReturnType<typeof useNativeChatNotesEditor>

/** Getting a viewer's notes to its chat: Send, or the hand-off on Close, both putting a marked copy
 *  and the numbered notes text into the message box. The notes live only in the viewer until then;
 *  when they can't go to the message box now, Close says why and offers Discard. */
export function useNativeChatNotesDelivery({
  opener,
  loaded,
  editor,
  title,
  onOpenChange,
  showPanel,
  onRestored
}: {
  opener: React.RefObject<Element | null>
  loaded: { size: PanZoomSize; image: HTMLImageElement } | null
  editor: Editor
  title: string
  onOpenChange: (open: boolean) => void
  /** Brings the notes panel back, for a question the user must answer there. */
  showPanel: () => void
  /** Notes need the user again (a hand-off failed): resume annotating. */
  onRestored: () => void
}) {
  const t = useTranslate()
  const { notes } = editor
  const [busy, setBusy] = useState(false)
  // One hand-off at a time: Esc or × while Send is still preparing must not start a second one.
  const busyRef = useRef(false)
  // The message box lives outside the viewer: looked up once the viewer and its image are on screen.
  const [composer, setComposer] = useState<NativeChatNotesComposer | null>(null)
  useLayoutEffect(() => {
    setComposer(nativeChatNotesComposer(opener.current))
  }, [loaded, opener])
  const closeViewer = useCallback((): void => onOpenChange(false), [onOpenChange])
  const showError = useCallback(
    (message: string, discard?: () => void): void => {
      editor.setStatus({ kind: 'error', message, ...(discard ? { discard } : {}) })
      // The failure is shown where the notes are: back to annotating, the panel open, the error focused.
      onRestored()
      showPanel()
      requestAnimationFrame(() => document.getElementById(NATIVE_CHAT_NOTES_ERROR_ID)?.focus())
    },
    [editor, onRestored, showPanel]
  )
  // A message box that can't say (no notesBlocked) is treated as holding a command; null means admitted.
  const blocked: NativeChatNotesBlocked = !composer
    ? 'unavailable'
    : composer.handle.notesBlocked
      ? composer.handle.notesBlocked()
      : 'command'
  // Send in the viewer sends the whole message: say so when the box already holds more than these notes.
  const draft = composer ? readNativeChatComposerDraft(composer.scopeKey) : null
  const includesMessage = draft !== null && (draft.text.trim() !== '' || draft.images.length > 0)
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
    blocked === null &&
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
      // What Undo puts back: the message as it was before these notes went in.
      const before = readNativeChatComposerDraft(composer.scopeKey)
      setBusy(true)
      // The image is drawn from these notes: no change to them until it is handed off or fails.
      editor.setLocked(true)
      let handed = false
      try {
        const added = await attachNativeChatNotes({
          composer,
          mediaName: title,
          notes,
          frame: async () => ({ image: loaded.image, ...loaded.size })
        })
        handed = true
        await afterComposerRender()
        if (approved) {
          submitNativeChatNotesIfApproved(approved, added)
          await afterComposerRender()
        }
        // Sent, the images have left the draft; when the box held the send back, say where they are.
        if (!send || nativeChatNotesStillInDraft(composer.scopeKey, added.ids)) {
          announceNativeChatNotesHandOff(composer.scopeKey, before, notes.length)
        }
      } catch (error) {
        console.error('[native-chat] notes hand-off failed', error)
        // Closing never keeps the user here: Discard closes without these notes.
        showError(nativeChatNotesHandOffErrorText(t, error), send ? undefined : closeViewer)
      }
      busyRef.current = false
      setBusy(false)
      editor.setLocked(false)
      return handed
    },
    [closeViewer, composer, editor, loaded, notes, opener, showError, t, title]
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
    if (notes.length > 0) {
      // The message box can't take them now: say why, with Discard as the way out.
      if (blocked !== null) {
        showError(nativeChatNotesBlockedReason(t, blocked), closeViewer)
        return
      }
      if (!loaded) {
        showError(
          t(
            'components.native-chat.notes.imageNotReady',
            'The image isn’t ready yet, so the notes can’t be drawn on it.'
          ),
          closeViewer
        )
        return
      }
      if (!(await handOff(false))) {
        return
      }
    }
    closeViewer()
  }
  const send = async (): Promise<void> => {
    if (canSend && (await handOff(true))) {
      closeViewer()
    }
  }
  return { busy, canSend, sendReason, close, send }
}
