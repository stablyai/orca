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

export function requestCapturedTerminalReconfirmation(
  currentBinding: object | undefined,
  capturedBinding: TerminalCapturedInputBinding | undefined
): void {
  if (currentBinding === capturedBinding) {
    capturedBinding?.requestWindowsShiftEnterReconfirmation?.()
  }
}
