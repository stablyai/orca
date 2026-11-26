import { useCallback, useRef, type CompositionEvent, type FormEvent, type RefObject } from 'react'
import type { ScrcpyKeyboard } from '../streaming/use-emulator-control-stream'
import type { HeldSimulatorInput, HeldSimulatorInputSinks } from './simulator-keyboard-input'

type UseEmulatorKeyboardProxyArgs = {
  canInteract: boolean
  captureActiveRef: RefObject<boolean>
  heldInput: HeldSimulatorInput
  scrcpyKeyboard: ScrcpyKeyboard | null
  simulatorSinks: HeldSimulatorInputSinks
}

/**
 * The hidden editable the emulator pane focuses, so host input methods (Pinyin, Kotoeri, dead
 * keys) compose; each committed string goes to the device once, through the shared text path.
 */
export function useEmulatorKeyboardProxy({
  canInteract,
  captureActiveRef,
  heldInput,
  scrcpyKeyboard,
  simulatorSinks
}: UseEmulatorKeyboardProxyArgs) {
  const keyboardProxyRef = useRef<HTMLTextAreaElement | null>(null)
  // A synced simulator composes dead keys itself, so the Mac's own composition of them is dropped.
  const physicalDeadKeyRef = useRef(false)

  const commit = useCallback(
    (proxy: HTMLTextAreaElement): void => {
      const text = proxy.value
      proxy.value = ''
      if (!text || !canInteract || !captureActiveRef.current) {
        return
      }
      if (scrcpyKeyboard) {
        void scrcpyKeyboard.sendText(text)
      } else {
        heldInput.commitText(text, simulatorSinks)
      }
    },
    [canInteract, captureActiveRef, heldInput, scrcpyKeyboard, simulatorSinks]
  )

  const onKeyboardProxyCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      if (physicalDeadKeyRef.current) {
        physicalDeadKeyRef.current = false
        event.currentTarget.value = ''
        return
      }
      commit(event.currentTarget)
    },
    [commit]
  )

  // Text an input method inserts without composing (Chinese punctuation, the emoji picker).
  const onKeyboardProxyInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      if (!(event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing)) {
        commit(event.currentTarget)
      }
    },
    [commit]
  )

  return {
    keyboardProxyRef,
    onKeyboardProxyCompositionEnd,
    onKeyboardProxyInput,
    physicalDeadKeyRef
  }
}
