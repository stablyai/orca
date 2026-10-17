import type { Terminal } from '@xterm/xterm'
import { rescalePixelMouseReport } from './terminal-capability-replies'
import { subscribeToTerminalInputData } from './terminal-user-input-signal'

/** xterm input bound for the PTY: provenance kept, pixel mouse reports on the replied cell grid. */
export function subscribeToTerminalPtyInputData(
  terminal: Terminal,
  listener: (data: string, wasUserInput: boolean) => void
): { dispose: () => void } {
  return subscribeToTerminalInputData(terminal, (data, wasUserInput) => {
    // Why here: rescale with the geometry xterm measured the click on, before any deferral.
    listener(rescalePixelMouseReport(terminal, data), wasUserInput)
  })
}
