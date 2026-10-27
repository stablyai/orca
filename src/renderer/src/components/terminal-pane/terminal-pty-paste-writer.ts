import type { PtyTransport } from './pty-transport-types'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

type TerminalPastePtyWriter = Pick<PtyTransport, 'sendInput' | 'sendInputAccepted'>

export function writeTerminalPastePtyInput(
  transport: TerminalPastePtyWriter | undefined,
  data: string,
  inputKind: TerminalInputKind,
  signal?: AbortSignal
): boolean | Promise<boolean> {
  if (!transport) {
    return false
  }
  // sendInput only queues writes; await sendInputAccepted so paste chunking respects PTY backpressure.
  const accepted = signal
    ? transport.sendInputAccepted?.(data, inputKind, { signal })
    : transport.sendInputAccepted?.(data, inputKind)
  return accepted ?? transport.sendInput(data, inputKind)
}
