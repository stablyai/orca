import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent
} from 'react'
import {
  buildServeSimKeyboardFramesForKey,
  buildServeSimKeyboardFramesForText,
  type ServeSimKeyboardFrame
} from '../../../../shared/emulator-keyboard-frame'

type UseEmulatorScreenKeyboardArgs = {
  canInteract: boolean
  sendKeyboardFrames: (frames: ServeSimKeyboardFrame[]) => boolean
}

export function useEmulatorScreenKeyboard({
  canInteract,
  sendKeyboardFrames
}: UseEmulatorScreenKeyboardArgs) {
  const captureActiveRef = useRef(false)
  const [keyboardCaptureActive, setKeyboardCaptureActive] = useState(false)

  const setCaptureActive = useCallback((active: boolean): void => {
    captureActiveRef.current = active
    setKeyboardCaptureActive(active)
  }, [])

  useEffect(() => {
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

      const frames = buildServeSimKeyboardFramesForKey(event.key, { shift: event.shiftKey })
      if (!frames || !sendKeyboardFrames(frames)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [canInteract, sendKeyboardFrames, setCaptureActive]
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
      const frames = buildServeSimKeyboardFramesForText(text)
      if (!frames || !sendKeyboardFrames(frames)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [canInteract, sendKeyboardFrames]
  )

  return {
    enableKeyboardCapture,
    handleBlur,
    handleKeyDown,
    handlePaste,
    keyboardCaptureActive
  }
}
