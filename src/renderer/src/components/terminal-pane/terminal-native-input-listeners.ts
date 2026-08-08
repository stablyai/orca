import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import type { TerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'

export type TerminalNativeInputListenerOptions = {
  /**
   * Whether blur forgets the tracked Option side. Required so each window states
   * its own answer: an Option held across a focus round-trip keeps its left/right
   * identity when false (its Alt keyup lands in whichever window took focus), and
   * loses it when true. The two windows have always differed here.
   */
  forgetOptionKeyLocationOnBlur: boolean
}

export function installTerminalNativeInputListeners(
  target: Window,
  tracker: TerminalNativeOnlyShortcutTracker,
  setOptionKeyLocation: (location: number) => void,
  { forgetOptionKeyLocationOnBlur }: TerminalNativeInputListenerOptions
): () => void {
  // Why: a character key's location reports its own position, so left-vs-right
  // Option must be recorded from the modifier's own keydown.
  const onModifierDown = (event: KeyboardEvent): void => {
    if (!isImeOwnedKeyboardEvent(event) && event.key === 'Alt') {
      setOptionKeyLocation(event.location)
    }
  }
  const onModifierUp = (event: KeyboardEvent): void => {
    if (!isImeOwnedKeyboardEvent(event) && event.key === 'Alt') {
      setOptionKeyLocation(0)
    }
  }
  const onCompanion = (event: KeyboardEvent): void => {
    if (isImeOwnedKeyboardEvent(event) || !tracker.consumeCompanion(event)) {
      return
    }
    if (event.type === 'keypress') {
      event.preventDefault()
    }
    event.stopImmediatePropagation()
  }
  const onBeforeInput = (event: Event): void => {
    if (!(event instanceof InputEvent) || !tracker.shouldSuppressBeforeInput(event)) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onBlur = (): void => {
    if (forgetOptionKeyLocationOnBlur) {
      setOptionKeyLocation(0)
    }
    tracker.clear()
  }

  target.addEventListener('keydown', onModifierDown, true)
  target.addEventListener('keyup', onModifierUp, true)
  target.addEventListener('keypress', onCompanion, true)
  target.addEventListener('keyup', onCompanion, true)
  target.addEventListener('beforeinput', onBeforeInput, true)
  target.addEventListener('blur', onBlur)

  return () => {
    target.removeEventListener('keydown', onModifierDown, true)
    target.removeEventListener('keyup', onModifierUp, true)
    target.removeEventListener('keypress', onCompanion, true)
    target.removeEventListener('keyup', onCompanion, true)
    target.removeEventListener('beforeinput', onBeforeInput, true)
    target.removeEventListener('blur', onBlur)
  }
}
