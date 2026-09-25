import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useEffect, useRef } from 'react'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'

export function useNativeChatComposerAppMenuSelection(isComposingOverride?: () => boolean) {
  const textareaRef = useRef<NativeChatComposerInput>(null)
  const isComposingRef = useRef(false)
  const isComposing = useCallback(
    () => isComposingOverride?.() ?? isComposingRef.current,
    [isComposingOverride]
  )

  useEffect(() => {
    const onSelectionAction = (event: Event): void => {
      const textarea = textareaRef.current
      if (
        (event as CustomEvent<AppMenuSelectionAction>).detail !== 'select-all' ||
        !textarea ||
        !textarea.contains?.(document.activeElement)
      ) {
        return
      }
      event.preventDefault()
      if (!isComposing()) {
        textarea.select()
      }
    }

    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
    return () => window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
  }, [isComposing, textareaRef])

  return { textareaRef, isComposingRef, isComposing }
}
