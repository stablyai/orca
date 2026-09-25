import type { PtyTransport } from './pty-transport'
import type { PtyInputOptions } from './pty-transport-types'

type TerminalPastePtyWriter = Pick<PtyTransport, 'sendInput' | 'sendInputAccepted'>

export function writeTerminalPastePtyInput(
  transport: TerminalPastePtyWriter | undefined,
  data: string,
  options?: PtyInputOptions
): boolean | Promise<boolean> {
  if (!transport) {
    return false
  }
  // Why: paste chunking must respect PTY backpressure. sendInput only queues
  // local writes, while sendInputAccepted resolves after the PTY accepts them.
  const optionArgs: [PtyInputOptions] | [] = options ? [options] : []
  return (
    transport.sendInputAccepted?.(data, ...optionArgs) ?? transport.sendInput(data, ...optionArgs)
  )
}
