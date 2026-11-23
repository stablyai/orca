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
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'
import {
  buildServeSimKeyboardFramesForCode,
  buildServeSimKeyboardFramesForKey,
  type ServeSimKeyboardFrame
} from '../../../../../shared/emulator/emulator-keyboard-frame'
import type { ScrcpyKeyboard } from '../streaming/use-emulator-control-stream'
import { pasteTextIntoEmulator, type EmulatorKeyboardPasteResult } from './emulator-keyboard-paste'

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

type SimulatorKeyPress = {
  alt: boolean
  /** Caps Lock capitalized a character; the guest has no Caps Lock state of its own. */
  capsLetter: boolean
  code: string
  key: string
  shift: boolean
}

// Synced simulators take the physical key; unsynced ones keep a US layout, so the character picks its US key.
function simulatorKeyFrames(
  press: SimulatorKeyPress,
  physicalKeys: boolean
): ServeSimKeyboardFrame[] | null {
  if (physicalKeys) {
    return buildServeSimKeyboardFramesForCode(press.code, {
      alt: press.alt,
      shift: press.shift || press.capsLetter
    })
  }
  // Option composes characters only through the guest's own layout.
  return press.alt ? null : buildServeSimKeyboardFramesForKey(press.key, { shift: press.shift })
}

type UseEmulatorScreenKeyboardArgs = {
  cancelKeyboardFrames: () => void
  canInteract: boolean
  /** Set for Android panes, which have no serve-sim socket for HID frames. */
  scrcpyKeyboard: ScrcpyKeyboard | null
  sendKeyboardFrames: (frames: ServeSimKeyboardFrame[]) => boolean
  worktreeId: string
}

export function useEmulatorScreenKeyboard({
  cancelKeyboardFrames,
  canInteract,
  scrcpyKeyboard,
  sendKeyboardFrames,
  worktreeId
}: UseEmulatorScreenKeyboardArgs) {
  const captureActiveRef = useRef(false)
  const pasteRequestIdRef = useRef(0)
  // True once main has put the simulator's hardware layout on the Mac's, so physical keys type what the Mac key shows.
  const physicalKeysRef = useRef(false)
  const layoutSyncIdRef = useRef(0)
  // Non-null while a layout sync is in flight: keys wait so none is sent under the old layout.
  const pendingKeyPressesRef = useRef<SimulatorKeyPress[] | null>(null)
  const [keyboardCaptureActive, setKeyboardCaptureActive] = useState(false)

  const syncKeyboardLayout = useCallback((): void => {
    if (scrcpyKeyboard) {
      return
    }
    const syncId = ++layoutSyncIdRef.current
    if (pendingKeyPressesRef.current === null) {
      pendingKeyPressesRef.current = []
    }
    void callRuntimeRpc<{ physicalKeys: boolean }>(
      { kind: 'local' },
      'emulator.syncKeyboardLayout',
      {
        worktree: worktreeId
      }
    )
      .then((result) => result.physicalKeys === true)
      .catch(() => false)
      .then((physicalKeys) => {
        if (syncId !== layoutSyncIdRef.current) {
          return
        }
        physicalKeysRef.current = physicalKeys
        const presses = pendingKeyPressesRef.current ?? []
        pendingKeyPressesRef.current = null
        // One call keeps the held keys in order; separate calls would interleave their spaced frames.
        const frames = presses.flatMap((press) => simulatorKeyFrames(press, physicalKeys) ?? [])
        if (frames.length > 0 && captureActiveRef.current) {
          sendKeyboardFrames(frames)
        }
      })
  }, [scrcpyKeyboard, sendKeyboardFrames, worktreeId])

  const cancelActivePaste = useCallback((): void => {
    pasteRequestIdRef.current += 1
    cancelKeyboardFrames()
  }, [cancelKeyboardFrames])

  const setCaptureActive = useCallback(
    (active: boolean): void => {
      if (!active) {
        cancelActivePaste()
        // Keys buffered for this capture must not be delivered into a later one.
        layoutSyncIdRef.current += 1
        pendingKeyPressesRef.current = null
      } else if (!captureActiveRef.current) {
        syncKeyboardLayout()
      }
      captureActiveRef.current = active
      setKeyboardCaptureActive(active)
    },
    [cancelActivePaste, syncKeyboardLayout]
  )

  // A Mac input source switch while typing into the simulator moves its layout too.
  useEffect(
    () =>
      window.api.app.onKeyboardLayoutChanged((event) => {
        if (event.phase === 'invalidated' && captureActiveRef.current) {
          syncKeyboardLayout()
        }
      }),
    [syncKeyboardLayout]
  )

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
      const simulatorOption =
        !scrcpyKeyboard && (physicalKeysRef.current || pendingKeyPressesRef.current !== null)
      // Android takes whatever character the host layout produced as text, Option and AltGr ones too.
      const androidText = scrcpyKeyboard !== null && [...event.key].length === 1
      // AltGr arrives as Ctrl+Alt on Windows and Linux; its characters are text, not a Ctrl shortcut.
      const altGraphText = androidText && event.getModifierState('AltGraph')
      // Only Mac Option composes a character; plain Alt+letter elsewhere stays a shortcut.
      const optionText = androidText && isMacUserAgent()
      if (
        !canInteract ||
        event.nativeEvent.isComposing ||
        event.metaKey ||
        (event.ctrlKey && !altGraphText) ||
        (event.altKey && !simulatorOption && !optionText && !altGraphText)
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

      if (!scrcpyKeyboard) {
        const press: SimulatorKeyPress = {
          alt: event.altKey,
          capsLetter:
            event.getModifierState('CapsLock') &&
            [...event.key].length === 1 &&
            event.key !== event.key.toLowerCase(),
          code: event.code,
          key: event.key,
          shift: event.shiftKey
        }
        const pending = pendingKeyPressesRef.current
        if (pending) {
          pending.push(press)
        } else {
          const frames = simulatorKeyFrames(press, physicalKeysRef.current)
          if (!frames || !sendKeyboardFrames(frames)) {
            return
          }
        }
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const button = ANDROID_KEY_BUTTONS[event.key]
      if (button) {
        scrcpyKeyboard.sendKey(button, event.shiftKey)
      } else if (androidText) {
        void scrcpyKeyboard.sendText(event.key)
      } else {
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
      const paste = pasteTextIntoEmulator({
        send: scrcpyKeyboard
          ? scrcpyKeyboard.pasteText
          : (value) =>
              callRuntimeRpc({ kind: 'local' }, 'emulator.type', {
                paste: true,
                text: value,
                worktree: worktreeId
              })
                .then(() => true)
                .catch(() => false),
        text
      })
      void paste.then((result) => {
        if (pasteRequestIdRef.current === pasteRequestId) {
          showEmulatorKeyboardPasteResult(result)
        }
      })
    },
    [canInteract, cancelActivePaste, scrcpyKeyboard, worktreeId]
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

  toast.error(
    translate(
      'auto.components.emulator.pane.useEmulatorScreenKeyboard.pasteTargetUnavailable',
      'Emulator keyboard paste failed because the device is not ready.'
    )
  )
}
