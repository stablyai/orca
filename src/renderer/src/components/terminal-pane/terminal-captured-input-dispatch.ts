import type { IDisposable } from '@xterm/xterm'
import type { PtyTransport } from './pty-transport'
import type { TerminalKittyShortcutInput } from './terminal-kitty-shortcut-input'

type CapturedTerminalInputDispatch = {
  targetPaneMounted: boolean
  currentTransport: PtyTransport | undefined
  capturedTransport: PtyTransport | undefined
  capturedPtyId: string | null
  data: string
  onAccepted?: () => void
}

export type TerminalCapturedInputBinding = {
  requestWindowsShiftEnterReconfirmation?: () => void
  markShortcutTerminalInputSent?: () => void
  dispatchKittyShortcutInput?: (
    input: TerminalKittyShortcutInput,
    send: (data: string) => void
  ) => boolean
}

export function sendCapturedTerminalInput({
  targetPaneMounted,
  currentTransport,
  capturedTransport,
  capturedPtyId,
  data,
  onAccepted
}: CapturedTerminalInputDispatch): boolean {
  if (
    !targetPaneMounted ||
    !capturedTransport ||
    capturedPtyId === null ||
    currentTransport !== capturedTransport ||
    capturedTransport.getPtyId() !== capturedPtyId
  ) {
    return false
  }
  const sent = capturedTransport.sendInput(data)
  if (sent) {
    onAccepted?.()
  }
  return sent
}

/** currentBinding arrives as the pane's raw xterm binding; only its identity is read. */
export function requestCapturedTerminalReconfirmation(
  currentBinding: IDisposable | TerminalCapturedInputBinding | undefined,
  capturedBinding: TerminalCapturedInputBinding | undefined
): void {
  if (currentBinding === capturedBinding) {
    capturedBinding?.requestWindowsShiftEnterReconfirmation?.()
  }
}

/**
 * Sends a captured shortcut through the pane binding's kitty settlement when it
 * has one, so modifier-sensitive bytes wait for attach-time keyboard state.
 * An override (an already-resolved payload such as an Option release) is sent
 * verbatim in both modes.
 */
export function createShortcutInputSender(args: {
  getBinding: () => TerminalCapturedInputBinding | undefined
  kittyKeyboardInput: TerminalKittyShortcutInput | undefined
  sendResolvedInput: () => void
  sendData: (data: string) => void
}): (dataOverride?: string) => void {
  const { getBinding, kittyKeyboardInput, sendResolvedInput, sendData } = args
  return (dataOverride) => {
    const input =
      dataOverride !== undefined
        ? { kitty: dataOverride, legacy: dataOverride }
        : kittyKeyboardInput
    if (input && getBinding()?.dispatchKittyShortcutInput?.(input, sendData) === true) {
      return
    }
    if (dataOverride !== undefined) {
      sendData(dataOverride)
      return
    }
    sendResolvedInput()
  }
}
