import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { useAppStore } from '@/store/index'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import { findNativeChatPasteField } from '@/components/native-chat/paste/native-chat-paste-request'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import {
  isNativeChatKeyOwnerTarget,
  shouldFocusNativeChatComposerFromEditingKey,
  shouldFocusNativeChatInputForPaste,
  shouldRedirectNativeChatTyping,
  type KeyboardRedirectEvent
} from './native-chat-typing-redirect'

type NativeChatRootKeyEvent = KeyboardRedirectEvent & {
  code?: string
  keyCode?: number
  repeat?: boolean
  nativeEvent?: { isComposing?: boolean }
  preventDefault: () => void
  stopPropagation: () => void
}

export function routeNativeChatRootKeyToInput(
  event: NativeChatRootKeyEvent,
  composer: NativeChatComposerHandle | null,
  questionAnswerInput: HTMLInputElement | HTMLTextAreaElement | null
): void {
  const composing =
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229 ||
    composer?.isComposing?.() === true
  const platform = getShortcutPlatform()
  if (
    !event.defaultPrevented &&
    !event.repeat &&
    !composing &&
    !isNativeChatKeyOwnerTarget(event.target) &&
    !hasVisibleOverlay({ ignoreDismissed: true }) &&
    composer?.openWorkTargetPicker &&
    keybindingMatchesAction(
      'chat.pickWorkTarget',
      {
        key: event.key,
        code: event.code ?? '',
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey === true,
        shiftKey: event.shiftKey === true
      },
      platform,
      useAppStore.getState().keybindings
    ) &&
    composer.openWorkTargetPicker()
  ) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
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
  const isMac = platform === 'darwin'
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
