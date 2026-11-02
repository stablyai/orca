import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { findNativeChatPasteField } from '@/lib/native-chat-paste-request'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldFocusNativeChatInputForPaste,
  shouldRedirectNativeChatTyping,
  type KeyboardRedirectEvent
} from './native-chat-typing-redirect'

type NativeChatRootKeyEvent = KeyboardRedirectEvent & {
  preventDefault: () => void
  stopPropagation: () => void
}

export function routeNativeChatRootKeyToInput(
  event: NativeChatRootKeyEvent,
  composer: NativeChatComposerHandle | null,
  questionAnswerInput: HTMLInputElement | null
): void {
  // A focused transcript or code box owns Space paging; typing elsewhere still reaches the composer.
  if (
    event.key === ' ' &&
    event.target instanceof HTMLElement &&
    event.target.matches('[data-native-chat-scroll], [data-native-chat-code-content]') &&
    event.target.ownerDocument.activeElement === event.target
  ) {
    return
  }
  // Editing keys outside inputs focus the composer without inserting text.
  if (shouldFocusNativeChatComposerFromEditingKey(event)) {
    composer?.focus()
    return
  }
  // Resolve an editing card before the primary input so the native paste keeps its owner.
  const isMac = getShortcutPlatform() === 'darwin'
  if (shouldFocusNativeChatInputForPaste(event, isMac)) {
    const field = findNativeChatPasteField(event.target)
    if (field) {
      field.focus({ preventScroll: true })
    } else {
      ;(composer ?? questionAnswerInput)?.focus()
    }
    return
  }
  if (!shouldRedirectNativeChatTyping(event, isMac)) {
    return
  }
  if (!composer?.insertTypedText(event.key)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
}
