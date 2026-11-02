import { nativeChatComposerDestination } from './native-chat-composer-destination'
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
  /** Paste here while the question card owns input and the composer is unmounted. */
  questionAnswerInputRef?: RefObject<HTMLInputElement | null>
}

function canPasteIntoAnswerInput(input: HTMLInputElement): boolean {
  return input.isConnected && !input.disabled && !input.closest('[hidden], [inert]')
}

/** Text-only on purpose: an answer input takes no image attachments. */
function pasteClipboardTextInto(input: HTMLInputElement, stillTarget: () => boolean): void {
  const canContinue = () => canPasteIntoAnswerInput(input) && stillTarget()
  if (!canContinue()) {
    return
  }
  void (async () => {
    const text = await window.api.ui
      .readClipboardText({ maxBytes: TEXT_CONTROL_PASTE_MAX_BYTES })
      .catch(() => '')
    if (text.length > 0 && canContinue()) {
      await pasteTextIntoTextControl(input, text, {
        source: 'programmatic',
        canContinue
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
      if (nativeChatComposerDestination(rootRef.current, composerRef.current)) {
        nativeChatComposerDestination(rootRef.current, composerRef.current)?.pasteFromClipboard()
        return
      }
      const answerInput = questionAnswerInputRef?.current
      if (answerInput && canPasteIntoAnswerInput(answerInput)) {
        pasteClipboardTextInto(answerInput, () => questionAnswerInputRef?.current === answerInput)
      }
    },
    [composerRef, questionAnswerInputRef, rootRef]
  )

  // Capture at the pane so composer remounts cannot miss image pastes.
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
        if (
          event.target instanceof Node &&
          nativeChatComposerDestination(rootRef.current, composerRef.current)?.contains(
            event.target
          )
        ) {
          nativeChatComposerDestination(rootRef.current, composerRef.current)?.handlePasteEvent(
            event
          )
        }
        return
      }
      const composer = nativeChatComposerDestination(rootRef.current, composerRef.current)
      if (composer) {
        composer.handlePasteEvent(event)
        event.preventDefault()
        return
      }
      const answerInput = questionAnswerInputRef?.current
      if (answerInput && canPasteIntoAnswerInput(answerInput)) {
        const text = event.clipboardData?.getData('text/plain')
        event.preventDefault()
        if (text) {
          void pasteTextIntoTextControl(answerInput, text, {
            source: 'programmatic',
            canContinue: () =>
              questionAnswerInputRef?.current === answerInput &&
              canPasteIntoAnswerInput(answerInput)
          })
        }
      }
      // Without mounted inputs, leave paste unclaimed so the chat cover shows its refusal.
    }
    // Chromium may target a stale selection in another pane or the body.
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
    // Named-pane paste requests carry no clipboard event data.
    const onPasteRequest = (event: Event): void => {
      const answerInput = questionAnswerInputRef?.current
      if (
        nativeChatComposerDestination(rootRef.current, composerRef.current) ||
        (answerInput && canPasteIntoAnswerInput(answerInput))
      ) {
        event.preventDefault()
        pasteClipboardIntoComposer()
      }
    }
    const onAppMenuPaste = (event: Event & { detail?: unknown }): void => {
      if (event.defaultPrevented) {
        return
      }
      const activeElement = document.activeElement
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
        !nativeChatComposerDestination(rootRef.current, composerRef.current)?.contains(
          activeElement
        ) &&
        activeElement !== questionAnswerInputRef?.current
      ) {
        return
      }
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
