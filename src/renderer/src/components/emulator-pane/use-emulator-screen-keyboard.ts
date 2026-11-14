import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent
} from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  buildServeSimKeyboardFramesForKey,
  type ServeSimKeyboardFrame
} from '../../../../shared/emulator-keyboard-frame'
import type { ScrcpyKeyboard } from './use-emulator-control-stream'
import {
  pasteTextIntoAndroidEmulator,
  pasteTextIntoEmulatorKeyboard,
  type EmulatorKeyboardPasteResult
} from './emulator-keyboard-paste'

// Android keycode names (see android-input-mapping.ts) for the named keys; others type as text.
const ANDROID_KEY_BUTTONS: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'forward_delete',
  ArrowUp: 'dpad_up',
  ArrowDown: 'dpad_down',
  ArrowLeft: 'dpad_left',
  ArrowRight: 'dpad_right',
  Home: 'move_home',
  End: 'move_end',
  PageUp: 'page_up',
  PageDown: 'page_down'
}

type UseEmulatorScreenKeyboardArgs = {
  cancelKeyboardFrames: () => void
  canInteract: boolean
  /** Set for Android panes, which have no serve-sim socket for HID frames. */
  scrcpyKeyboard: ScrcpyKeyboard | null
  sendKeyboardFrames: (frames: ServeSimKeyboardFrame[]) => boolean
}

export function useEmulatorScreenKeyboard({
  cancelKeyboardFrames,
  canInteract,
  scrcpyKeyboard,
  sendKeyboardFrames
}: UseEmulatorScreenKeyboardArgs) {
  const captureActiveRef = useRef(false)
  const canInteractRef = useRef(canInteract)
  const pasteRequestIdRef = useRef(0)
  const [keyboardCaptureActive, setKeyboardCaptureActive] = useState(false)

  const cancelActivePaste = useCallback((): void => {
    pasteRequestIdRef.current += 1
    cancelKeyboardFrames()
  }, [cancelKeyboardFrames])

  const setCaptureActive = useCallback(
    (active: boolean): void => {
      if (!active) {
        cancelActivePaste()
      }
      captureActiveRef.current = active
      setKeyboardCaptureActive(active)
    },
    [cancelActivePaste]
  )

  useEffect(() => {
    canInteractRef.current = canInteract
    if (!canInteract) {
      setCaptureActive(false)
    }
  }, [canInteract, setCaptureActive])

  const enableKeyboardCapture = useCallback(() => {
    if (canInteract) {
      setCaptureActive(true)
    }
  }, [canInteract, setCaptureActive])

  const handleBlur = useCallback(() => {
    setCaptureActive(false)
  }, [setCaptureActive])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        !canInteract ||
        event.nativeEvent.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return
      }

      if (event.key === 'Escape') {
        if (captureActiveRef.current) {
          setCaptureActive(false)
          event.currentTarget.blur()
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      if (!captureActiveRef.current) {
        if (event.key === 'Enter' || event.key === ' ') {
          setCaptureActive(true)
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      // The HID table also decides which keys an Android pane accepts.
      const frames = buildServeSimKeyboardFramesForKey(event.key, { shift: event.shiftKey })
      if (!frames) {
        return
      }
      if (scrcpyKeyboard) {
        const button = ANDROID_KEY_BUTTONS[event.key]
        if (button) {
          scrcpyKeyboard.sendKey(button, event.shiftKey)
        } else {
          void scrcpyKeyboard.sendText(event.key)
        }
      } else if (!sendKeyboardFrames(frames)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [canInteract, scrcpyKeyboard, sendKeyboardFrames, setCaptureActive]
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (!canInteract || !captureActiveRef.current) {
        return
      }
      const text = event.clipboardData.getData('text')
      if (!text) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      cancelActivePaste()
      const pasteRequestId = pasteRequestIdRef.current
      const paste = scrcpyKeyboard
        ? pasteTextIntoAndroidEmulator({ sendText: scrcpyKeyboard.sendText, text })
        : pasteTextIntoEmulatorKeyboard({
            isCancelled: () =>
              pasteRequestIdRef.current !== pasteRequestId ||
              !captureActiveRef.current ||
              !canInteractRef.current,
            sendKeyboardFrames,
            text
          })
      void paste.then((result) => {
        if (pasteRequestIdRef.current !== pasteRequestId && result.status !== 'cancelled') {
          return
        }
        showEmulatorKeyboardPasteResult(result)
      })
    },
    [canInteract, cancelActivePaste, scrcpyKeyboard, sendKeyboardFrames]
  )

  return {
    enableKeyboardCapture,
    handleBlur,
    handleKeyDown,
    handlePaste,
    keyboardCaptureActive
  }
}

function showEmulatorKeyboardPasteResult(result: EmulatorKeyboardPasteResult): void {
  if (result.status !== 'rejected' || result.reason === 'empty') {
    return
  }

  if (result.reason === 'too-large') {
    toast.error(
      translate(
        'auto.components.emulator.pane.useEmulatorScreenKeyboard.pasteTooLarge',
        'Paste is too large for emulator keyboard input.'
      )
    )
    return
  }

  if (result.reason === 'unsupported-text') {
    toast.error(
      translate(
        'auto.components.emulator.pane.useEmulatorScreenKeyboard.unsupportedPasteText',
        'Emulator keyboard paste supports US keyboard text only.'
      )
    )
    return
  }

  toast.error(
    translate(
      'auto.components.emulator.pane.useEmulatorScreenKeyboard.pasteTargetUnavailable',
      'Emulator keyboard paste failed because the device is not ready.'
    )
  )
}
