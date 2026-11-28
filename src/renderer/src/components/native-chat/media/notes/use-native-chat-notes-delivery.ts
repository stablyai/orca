import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import {
  nativeChatNotesBlockedReason,
  nativeChatNotesCloseBlockedText,
  type NativeChatNotesBlocked
} from './native-chat-notes-reasons'
import { NATIVE_CHAT_NOTES_ERROR_ID } from './NativeChatMediaNotesPanel'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { showNativeChatNotesNotice } from './native-chat-notes-notice'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import type { PanZoomSize } from '../../../../../../shared/document-preview/pan-zoom-view'
import type { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import {
  afterComposerRender,
  announceNativeChatNotesHandOff,
  attachNativeChatNotes,
  captureNativeChatNotesSend,
  nativeChatNotesComposer,
  nativeChatNotesComposerForScope,
  nativeChatNotesCloseErrorText,
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
  // Closed through Close, Send or Discard: nothing left to keep when the viewer goes.
  const settled = useRef(false)
  const closeViewer = useCallback((): void => {
    settled.current = true
    onOpenChange(false)
  }, [onOpenChange])
  // A viewer can go without closing: its message row unmounts (scrolled out of a long chat, or
  // replaced as output arrives), or something closes it past the guard. Its added notes then go to
  // the chat's message box as Close would put them, or the box says they couldn't. A note still
  // being typed goes with them: nothing the user wrote is dropped without a word.
  const latest = useRef({ notes: nativeChatNotesWithUnadded(editor), loaded, composer, title })
  useLayoutEffect(() => {
    latest.current = { notes: nativeChatNotesWithUnadded(editor), loaded, composer, title }
  })
  // Set once the viewer is gone, so a hand-off still in flight reports in the message box instead.
  const gone = useRef(false)
  useEffect(() => {
    gone.current = false
    return () => {
      gone.current = true
      if (!settled.current && !busyRef.current && latest.current.notes.length > 0) {
        void handOffFromGoneViewer(latest.current, translate)
      }
    }
  }, [])
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
  const blocked = blockedIn(composer)
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
      // The message box as it is now: it may have remounted (a new handle) since the viewer opened.
      const composer = nativeChatNotesComposer(opener.current)
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
          announceNativeChatNotesHandOff(composer.scopeKey, before, added, notes.length)
        }
      } catch (error) {
        console.error('[native-chat] notes hand-off failed', error)
        if (gone.current) {
          // The viewer went while the hand-off ran: nothing is left here to show the failure in.
          showGoneNotAdded(composer.scopeKey, title, t)
        } else if (send) {
          showError(nativeChatNotesHandOffErrorText(t, error))
        } else {
          // Closing never keeps the user here: Discard closes without these notes.
          showError(nativeChatNotesCloseErrorText(t, error), closeViewer)
        }
      }
      busyRef.current = false
      setBusy(false)
      editor.setLocked(false)
      return handed
    },
    [closeViewer, editor, loaded, notes, opener, showError, t, title]
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
      // The message box can't take them now (as it is now: it may have remounted): say why, with
      // Discard as the way out.
      const now = blockedIn(nativeChatNotesComposer(opener.current))
      if (now !== null) {
        showError(nativeChatNotesCloseBlockedText(t, now), closeViewer)
        return
      }
      if (!loaded) {
        showError(
          t('components.native-chat.notes.imageNotReady', 'The image isn’t ready yet.'),
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

/** Why this message box can't take notes now; null when it can. One that can't say (no
 *  notesBlocked) is treated as holding a command. */
function blockedIn(composer: NativeChatNotesComposer | null): NativeChatNotesBlocked {
  if (!composer) {
    return 'unavailable'
  }
  return composer.handle.notesBlocked ? composer.handle.notesBlocked() : 'command'
}

/** Hands the notes of a viewer that went away without closing to its chat's message box, found
 *  again from the box itself (the viewer's opener is gone with it). */
async function handOffFromGoneViewer(
  gone: {
    notes: readonly NativeChatMediaNote[]
    loaded: { size: PanZoomSize; image: HTMLImageElement } | null
    composer: NativeChatNotesComposer | null
    title: string
  },
  t: typeof translate
): Promise<void> {
  const { notes, loaded, title } = gone
  const saved = gone.composer
  // The box element saved at open is detached if the box remounted meanwhile: find it by its draft.
  const box = saved?.element?.isConnected
    ? nativeChatNotesComposer(saved.element)
    : saved
      ? nativeChatNotesComposerForScope(saved.scopeKey)
      : null
  const scopeKey = box?.scopeKey ?? saved?.scopeKey
  const lost = (): void => {
    if (scopeKey) {
      showGoneNotAdded(scopeKey, title, t)
    }
  }
  if (!box || !loaded || blockedIn(box) !== null) {
    lost()
    return
  }
  const before = readNativeChatComposerDraft(box.scopeKey)
  try {
    const added = await attachNativeChatNotes({
      composer: box,
      mediaName: title,
      notes,
      frame: async () => ({ image: loaded.image, ...loaded.size })
    })
    await afterComposerRender()
    announceNativeChatNotesHandOff(box.scopeKey, before, added, notes.length)
  } catch (error) {
    console.error('[native-chat] notes hand-off failed', error)
    lost()
  }
}

function showGoneNotAdded(scopeKey: string, title: string, t: typeof translate): void {
  showNativeChatNotesNotice(scopeKey, {
    text: t('components.native-chat.notes.goneNotAdded', 'Notes on {{name}} weren’t added.', {
      name: title
    })
  })
}

/** The viewer's notes with the one still being typed (a new note, or a changed one) as written. */
export function nativeChatNotesWithUnadded(
  editor: Pick<Editor, 'notes' | 'pending' | 'editing' | 'draftText' | 'hasUnadded'>
): readonly NativeChatMediaNote[] {
  if (!editor.hasUnadded) {
    return editor.notes
  }
  const text = editor.draftText.trim()
  if (editor.pending) {
    return [...editor.notes, { ...editor.pending, text }]
  }
  const editing = editor.editing
  return editing
    ? editor.notes.map((note) => (note.id === editing.id ? { ...note, text } : note))
    : editor.notes
}
