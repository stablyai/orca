import type { IDisposable } from '@xterm/xterm'
import type { PtyTransport } from './pty-transport'

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
