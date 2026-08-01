import type { PtyTransport } from './pty-transport'

type CapturedTerminalInputDispatch = {
  targetPaneMounted: boolean
  currentTransport: PtyTransport | undefined
  capturedTransport: PtyTransport | undefined
  capturedPtyId: string | null
  data: string
}

export type TerminalReconfirmationBinding = {
  requestDroidReconfirmation?: () => void
}

export function sendCapturedTerminalInput({
  targetPaneMounted,
  currentTransport,
  capturedTransport,
  capturedPtyId,
  data
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
  return capturedTransport.sendInput(data)
}

export function requestCapturedTerminalReconfirmation(
  currentBinding: object | undefined,
  capturedBinding: TerminalReconfirmationBinding | undefined
): void {
  if (currentBinding === capturedBinding) {
    capturedBinding?.requestDroidReconfirmation?.()
  }
}
