import type { PtyTransport } from './pty-transport-types'
import type { TerminalInputKind, TerminalInputOrigin } from '../../../../shared/terminal-input-kind'

type TerminalPastePtyWriter = Pick<PtyTransport, 'sendInput' | 'sendInputAccepted'>

export function writeTerminalPastePtyInput(
  transport: TerminalPastePtyWriter | undefined,
  data: string,
  inputKind: TerminalInputKind,
  signal?: AbortSignal,
  inputOrigin?: TerminalInputOrigin
): boolean | Promise<boolean> {
  if (!transport) {
    return false
  }
  // Why: paste chunking must respect PTY backpressure. sendInput only queues
  // local writes, while sendInputAccepted resolves after the PTY accepts them.
  const accepted = inputOrigin
    ? transport.sendInputAccepted?.(data, inputKind, { signal, inputOrigin })
    : signal
      ? transport.sendInputAccepted?.(data, inputKind, { signal })
      : transport.sendInputAccepted?.(data, inputKind)
  return (
    accepted ??
    (inputOrigin
      ? transport.sendInput(data, inputKind, inputOrigin)
      : transport.sendInput(data, inputKind))
  )
}
