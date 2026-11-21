import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent
} from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'
import type { ServeSimKeyboardFrame } from '../../../../../shared/emulator/emulator-keyboard-frame'
import {
  ANDROID_KEY_BUTTONS,
  KEYBOARD_FRAME_DELAY_MS,
  type ScrcpyKeyboard
} from '../streaming/use-emulator-control-stream'
import { pasteTextIntoEmulator, type EmulatorKeyboardPasteResult } from './emulator-keyboard-paste'
import {
  HeldSimulatorInput,
  simulatorKeyFrames,
  type HeldSimulatorInputSinks,
  type SimulatorKeyPress
} from './simulator-keyboard-input'
import { useEmulatorKeyboardProxy } from './use-emulator-keyboard-proxy'

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
  const [keyboardCaptureActive, setKeyboardCaptureActive] = useState(false)

  // Keys wait during a layout sync (so none goes under the old layout) and behind committed IME text.
  const [heldInput] = useState(() => new HeldSimulatorInput())
  const simulatorSinks = useMemo<HeldSimulatorInputSinks>(
    () => ({
      keyFrames: (press) => simulatorKeyFrames(press, physicalKeysRef.current),
      sendFrames: (frames) =>
        captureActiveRef.current && sendKeyboardFrames(frames)
          ? (frames.length - 1) * KEYBOARD_FRAME_DELAY_MS
          : null,
      typeText: (text) =>
        callRuntimeRpc({ kind: 'local' }, 'emulator.type', { text, worktree: worktreeId })
    }),
    [sendKeyboardFrames, worktreeId]
  )
  const { physicalDeadKeyRef, keyboardProxyRef, ...keyboardProxyHandlers } =
    useEmulatorKeyboardProxy({
      canInteract,
      captureActiveRef,
      heldInput,
      scrcpyKeyboard,
      simulatorSinks
    })

  const syncKeyboardLayout = useCallback((): void => {
    if (scrcpyKeyboard) {
      return
    }
    const syncId = ++layoutSyncIdRef.current
    heldInput.startSync()
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
        heldInput.finishSync(simulatorSinks)
      })
  }, [heldInput, scrcpyKeyboard, simulatorSinks, worktreeId])

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
        heldInput.clear()
        physicalDeadKeyRef.current = false
      } else if (!captureActiveRef.current) {
        syncKeyboardLayout()
      }
      captureActiveRef.current = active
      setKeyboardCaptureActive(active)
    },
    [cancelActivePaste, heldInput, physicalDeadKeyRef, syncKeyboardLayout]
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

  // Input still held when the pane closes must not reach the device afterwards.
  useEffect(() => () => heldInput.clear(), [heldInput])

  const enableKeyboardCapture = useCallback(() => {
    if (canInteract) {
      try {
        keyboardProxyRef.current?.focus({ preventScroll: true })
      } catch {}
      setCaptureActive(true)
    }
  }, [canInteract, keyboardProxyRef, setCaptureActive])

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      // Focus moving between the screen and its keyboard proxy stays in the pane.
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return
      }
      setCaptureActive(false)
    },
    [setCaptureActive]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const simulatorOption = !scrcpyKeyboard && (physicalKeysRef.current || heldInput.holding)
      // A key the host input method is composing with is the IME's; its text arrives on commit.
      const imeKey = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      // Only a simulator known to follow the Mac layout composes dead keys from physical keys.
      const simulatorDeadKey =
        !scrcpyKeyboard &&
        physicalKeysRef.current &&
        !heldInput.syncingLayout &&
        (event.key === 'Dead' || (imeKey && physicalDeadKeyRef.current))
      // Android takes whatever character the host layout produced as text, Option and AltGr ones too.
      const androidText = scrcpyKeyboard !== null && [...event.key].length === 1
      // AltGr arrives as Ctrl+Alt on Windows and Linux; its characters are text, not a Ctrl shortcut.
      const altGraphText = androidText && event.getModifierState('AltGraph')
      // Only Mac Option composes a character; plain Alt+letter elsewhere stays a shortcut.
      const optionText = androidText && isMacUserAgent()
      if (
        !canInteract ||
        ((imeKey || event.key === 'Dead') && !simulatorDeadKey) ||
        event.metaKey ||
        (event.ctrlKey && !altGraphText) ||
        (event.altKey && !simulatorOption && !optionText && !altGraphText)
      ) {
        return
      }

      if (event.key === 'Escape') {
        if (captureActiveRef.current) {
          setCaptureActive(false)
          keyboardProxyRef.current?.blur()
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
        // A key the simulator can't press is left to the proxy, which commits its text.
        if (heldInput.pressKey(press, simulatorSinks) === 'unsupported') {
          return
        }
        if (event.key === 'Dead' || !imeKey) {
          physicalDeadKeyRef.current = event.key === 'Dead'
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
    [
      canInteract,
      heldInput,
      keyboardProxyRef,
      physicalDeadKeyRef,
      scrcpyKeyboard,
      setCaptureActive,
      simulatorSinks
    ]
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
    keyboardCaptureActive,
    keyboardProxyRef,
    ...keyboardProxyHandlers
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
