import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { isEditableTarget } from '@/lib/editable-target'
import { NATIVE_CHAT_PASTE_REQUEST_EVENT } from '@/lib/native-chat-paste-request'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { pasteTextIntoTextControl, TEXT_CONTROL_PASTE_MAX_BYTES } from '@/lib/text-control-paste'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type NativeChatPasteBridgeRefs = {
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  /** The question card's free-text answer input; the paste target while the
   *  card owns the input region (the composer is unmounted then). */
  questionAnswerInputRef?: RefObject<HTMLInputElement | null>
}

export function useNativeChatPasteBridge({
  rootRef,
  composerRef,
  questionAnswerInputRef
}: NativeChatPasteBridgeRefs): () => void {
  const pasteClipboardIntoComposer = useCallback(() => {
    if (composerRef.current) {
      composerRef.current.pasteFromClipboard()
      return
    }
    const answerInput = questionAnswerInputRef?.current
    if (!answerInput) {
      return
    }
    // Text-only on purpose: the answer input takes no image attachments.
    void (async () => {
      const text = await window.api.ui
        .readClipboardText({ maxBytes: TEXT_CONTROL_PASTE_MAX_BYTES })
        .catch(() => '')
      if (text.length > 0 && questionAnswerInputRef?.current === answerInput) {
        await pasteTextIntoTextControl(answerInput, text, {
          source: 'programmatic',
          canContinue: () => questionAnswerInputRef?.current === answerInput
        })
      }
    })()
  }, [composerRef, questionAnswerInputRef])

  // Capture at the pane root so repeated composer mounts do not miss image paste.
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      if (isEditableTarget(event.target)) {
        // Other text fields (search, answer) keep their native paste.
        if (event.target instanceof Node && composerRef.current?.contains(event.target)) {
          composerRef.current.handlePasteEvent(event)
        }
        return
      }
      const composer = composerRef.current
      if (composer) {
        composer.handlePasteEvent(event)
        event.preventDefault()
        return
      }
      const answerInput = questionAnswerInputRef?.current
      if (answerInput) {
        const text = event.clipboardData?.getData('text/plain')
        event.preventDefault()
        if (text) {
          void pasteTextIntoTextControl(answerInput, text, {
            source: 'programmatic',
            canContinue: () => questionAnswerInputRef?.current === answerInput
          })
        }
      }
      // Neither input mounted: left unclaimed so the pane's chat cover refuses it visibly.
    }
    // Named-pane pastes (terminal context menu, a paste on the cover itself) carry no event data.
    const onPasteRequest = (event: Event): void => {
      if (!composerRef.current && !questionAnswerInputRef?.current) {
        return
      }
      event.preventDefault()
      pasteClipboardIntoComposer()
    }
    root.addEventListener('paste', onPaste, { capture: true })
    root.addEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onPasteRequest)
    return () => {
      root.removeEventListener('paste', onPaste, { capture: true })
      root.removeEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onPasteRequest)
    }
  }, [composerRef, rootRef, questionAnswerInputRef, pasteClipboardIntoComposer])

  useEffect(() => {
    const onAppMenuPaste = (event: Event): void => {
      if (event.defaultPrevented) {
        return
      }
      const root = rootRef.current
      const activeElement = document.activeElement
      // The app-menu paste event is window-scoped; only claim it when focus is
      // inside this chat pane so multiple panes don't all react to one Cmd+V.
      if (!root || !(activeElement instanceof Element) || !root.contains(activeElement)) {
        return
      }
      if (
        isEditableTarget(activeElement) &&
        !composerRef.current?.contains(activeElement) &&
        activeElement !== questionAnswerInputRef?.current
      ) {
        return
      }
      // No paste target mounted: leave the event unclaimed. The shared handler
      // then pastes natively, which the pane's chat cover turns into a refusal.
      if (!composerRef.current && !questionAnswerInputRef?.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pasteClipboardIntoComposer()
    }

    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [composerRef, pasteClipboardIntoComposer, questionAnswerInputRef, rootRef])

  return pasteClipboardIntoComposer
}
