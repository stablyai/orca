import { getShortcutPlatform } from '@/lib/shortcut-platform'
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

/** Routes a key pressed in the chat pane outside any input to the chat's input. */
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
  // Backspace/Delete outside an input focuses the composer (like typing)
  // but inserts nothing — let the now-focused field handle the keystroke.
  if (shouldFocusNativeChatComposerFromEditingKey(event)) {
    composer?.focus()
    return
  }
  // The question card replaces the composer, so at most one input exists. If it
  // cannot take focus (disabled), the paste reaches the bridge, which explains why.
  const isMac = getShortcutPlatform() === 'darwin'
  if (shouldFocusNativeChatInputForPaste(event, isMac)) {
    const input = composer ?? questionAnswerInput
    input?.focus()
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
