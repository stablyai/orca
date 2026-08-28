import type { PtyTransport } from './pty-transport'

type TerminalPastePtyWriter = Pick<
  PtyTransport,
  'sendInput' | 'sendInputAccepted' | 'sendInputSettled'
>

export function writeTerminalPastePtyInput(
  transport: TerminalPastePtyWriter | undefined,
  data: string
): boolean | Promise<boolean> {
  if (!transport) {
    return false
  }
  // Why: durable SSH delivery needs relay settlement; ordinary accepted writes
  // intentionally remain unavailable there to preserve interactive latency.
  return (
    transport.sendInputSettled?.(data) ??
    transport.sendInputAccepted?.(data) ??
    transport.sendInput(data)
  )
}
