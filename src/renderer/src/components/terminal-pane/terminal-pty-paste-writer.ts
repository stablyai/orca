import type { PtyTransport } from './pty-transport'
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
  // Why: paste chunking must respect PTY backpressure. sendInput only queues
  // local writes, while sendInputAccepted resolves after the PTY accepts them.
  const accepted = signal
    ? transport.sendInputAccepted?.(data, inputKind, { signal })
    : transport.sendInputAccepted?.(data, inputKind)
  return accepted ?? transport.sendInput(data, inputKind)
}
