import { nativeChatComposerDestination } from './native-chat-composer-destination'
import {
  useCallback,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { DICTATION_FOCUS_INPUT_EVENT } from '../dictation/dictation-control-events'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import { shouldFocusNativeChatPaneFromPointerTarget } from './native-chat-typing-redirect'
import {
  useNativeChatComposerRevealFocus,
  type NativeChatComposerRevealFocusArgs
} from './use-native-chat-composer-reveal-focus'

// Floating panels can reveal a chat beside the workspace’s chat.
const revealedChatRoots = new Set<HTMLElement>()

/** Route revealed-pane typing/dictation to its input when focus is unowned or within that chat. */
export function useNativeChatRootInputRouting(
  args: Omit<NativeChatComposerRevealFocusArgs, 'scheduleFrame'> & {
    questionAnswerInputRef: RefObject<HTMLInputElement | null>
  }
): {
  onPointerDownCapture: (event: ReactPointerEvent) => void
  onKeyDownCapture: (event: ReactKeyboardEvent) => void
} {
  const { rootRef, composerRef, questionAnswerInputRef } = args
  useNativeChatComposerRevealFocus(args)
  const revealed = args.isVisible && args.isFocusedGroup
  useEffect(() => {
    const root = rootRef.current
    if (!revealed || !root) {
      return
    }
    // Body/cover focus has no input owner; multiple revealed chats make its destination ambiguous.
    const ownsUnfocusedInput = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      target.contains(root) &&
      revealedChatRoots.size === 1 &&
      !hasVisibleOverlay({ ignoreDismissed: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target !== root && ownsUnfocusedInput(event.target)) {
        routeNativeChatRootKeyToInput(
          event,
          nativeChatComposerDestination(rootRef.current, composerRef.current),
          questionAnswerInputRef.current
        )
      }
    }
    const onDictationFocusInput = (): void => {
      const active = root.ownerDocument.activeElement
      if (root.contains(active) || ownsUnfocusedInput(active)) {
        nativeChatComposerDestination(rootRef.current, composerRef.current)?.focus()
      }
    }
    revealedChatRoots.add(root)
    root.ownerDocument.addEventListener('keydown', onKeyDown)
    root.ownerDocument.addEventListener(DICTATION_FOCUS_INPUT_EVENT, onDictationFocusInput)
    return () => {
      revealedChatRoots.delete(root)
      root.ownerDocument.removeEventListener('keydown', onKeyDown)
      root.ownerDocument.removeEventListener(DICTATION_FOCUS_INPUT_EVENT, onDictationFocusInput)
    }
  }, [composerRef, questionAnswerInputRef, revealed, rootRef])

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent) => {
      if (
        !event.defaultPrevented &&
        event.button === 0 &&
        shouldFocusNativeChatPaneFromPointerTarget(event.target)
      ) {
        rootRef.current?.focus({ preventScroll: true })
      }
    },
    [rootRef]
  )
  const onKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      // Portaled menus/dialogs still bubble through React; require a target inside this DOM root.
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        routeNativeChatRootKeyToInput(
          event,
          nativeChatComposerDestination(rootRef.current, composerRef.current),
          questionAnswerInputRef.current
        )
      }
    },
    [composerRef, questionAnswerInputRef, rootRef]
  )
  return { onPointerDownCapture, onKeyDownCapture }
}
