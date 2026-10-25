import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { toast } from 'sonner'
import { isEditableTarget } from '@/lib/editable-target'
import {
  NativeChatPasteRequest,
  findNativeChatAnswerField,
  findNativeChatPasteField,
  nativeChatPasteUnavailableNotice,
  NATIVE_CHAT_PASTE_REQUEST_EVENT
} from '@/lib/native-chat-paste-request'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { isWebClientLocation } from '@/lib/web-client-location'
import { pasteTextIntoTextControl, TEXT_CONTROL_PASTE_MAX_BYTES } from '@/lib/text-control-paste'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type NativeChatPasteBridgeRefs = {
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  /** The question card's free-text answer input; the paste target while the
   *  card owns the input region (the composer is unmounted then). */
  questionAnswerInputRef?: RefObject<HTMLInputElement | null>
}

/** Text-only on purpose: an answer input takes no image attachments. */
function pasteClipboardTextInto(input: HTMLInputElement, stillTarget: () => boolean): void {
  void (async () => {
    const text = await window.api.ui
      .readClipboardText({ maxBytes: TEXT_CONTROL_PASTE_MAX_BYTES })
      .catch(() => '')
    if (text.length > 0 && stillTarget()) {
      await pasteTextIntoTextControl(input, text, {
        source: 'programmatic',
        canContinue: stillTarget
      })
    }
  })()
}

export function useNativeChatPasteBridge({
  rootRef,
  composerRef,
  questionAnswerInputRef
}: NativeChatPasteBridgeRefs): (origin?: HTMLTextAreaElement | HTMLInputElement) => void {
  const pasteClipboardIntoComposer = useCallback(
    (
      origin?: HTMLTextAreaElement | HTMLInputElement,
      mode: 'paste' | 'paste-and-match-style' = 'paste'
    ) => {
      if (origin instanceof HTMLInputElement) {
        if (findNativeChatAnswerField(origin, rootRef.current) === origin) {
          pasteClipboardTextInto(origin, () => origin.isConnected)
        }
        return
      }
      if (origin) {
        if (findNativeChatPasteField(origin, rootRef.current) === origin) {
          origin.focus({ preventScroll: true })
          if (isWebClientLocation()) {
            origin.dispatchEvent(new NativeChatPasteRequest())
          } else {
            window.api.ui.performNativePaste({ mode })
          }
        } else {
          toast.error(nativeChatPasteUnavailableNotice())
        }
        return
      }
      if (composerRef.current) {
        composerRef.current.pasteFromClipboard()
        return
      }
      const answerInput = questionAnswerInputRef?.current
      if (answerInput) {
        pasteClipboardTextInto(answerInput, () => questionAnswerInputRef?.current === answerInput)
      }
    },
    [composerRef, questionAnswerInputRef, rootRef]
  )

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
    // Chromium may dispatch to an old selection in another pane or the body.
    const onOwnedPaste = (event: ClipboardEvent): void => {
      const field = findNativeChatPasteField(document.activeElement, root)
      if (event.defaultPrevented || !field) {
        return
      }
      field.focus({ preventScroll: true })
      if (event.target !== field) {
        field.dispatchEvent(new NativeChatPasteRequest(event))
        event.preventDefault()
      }
    }
    // Named-pane pastes (terminal context menu, a paste on the cover itself) carry no event data.
    const onPasteRequest = (event: Event): void => {
      if (composerRef.current || questionAnswerInputRef?.current) {
        event.preventDefault()
        pasteClipboardIntoComposer()
      }
    }
    const onAppMenuPaste = (event: Event & { detail?: unknown }): void => {
      if (event.defaultPrevented) {
        return
      }
      const activeElement = document.activeElement
      // Only the pane containing focus may claim this window-scoped command.
      if (!(activeElement instanceof Element) || !root.contains(activeElement)) {
        return
      }
      const field = findNativeChatPasteField(activeElement, root)
      if (field) {
        event.preventDefault()
        pasteClipboardIntoComposer(
          field,
          event.detail === 'paste-and-match-style' ? 'paste-and-match-style' : 'paste'
        )
        return
      }
      if (
        isEditableTarget(activeElement) &&
        !composerRef.current?.contains(activeElement) &&
        activeElement !== questionAnswerInputRef?.current
      ) {
        return
      }
      // With no mounted input, native delivery lets the chat cover show its refusal.
      onPasteRequest(event)
    }

    window.addEventListener('paste', onOwnedPaste, true)
    root.addEventListener('paste', onPaste, { capture: true })
    root.addEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onPasteRequest)
    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      window.removeEventListener('paste', onOwnedPaste, true)
      root.removeEventListener('paste', onPaste, { capture: true })
      root.removeEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onPasteRequest)
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [composerRef, pasteClipboardIntoComposer, questionAnswerInputRef, rootRef])

  return pasteClipboardIntoComposer
}
