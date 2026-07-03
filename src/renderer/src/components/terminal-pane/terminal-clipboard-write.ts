import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'

export function writeTerminalClipboardText(text: string): Promise<void> {
  // Why: desktop terminal copy UI must only report success after the OS
  // clipboard is pasteable (#5611). Browser read permission is separate, so
  // paired web clients keep the browser write promise as their success signal.
  return window.api.ui.writeClipboardText(
    text,
    isPairedWebClientWindow() ? undefined : { verify: true }
  )
}
