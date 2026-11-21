import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import type { TerminalInputKind } from '../../../../../../shared/terminal/input/terminal-input-kind'
import { noteTerminalWebglAtlasTyping } from '@/lib/pane-manager/terminal-rendering/terminal-webgl-atlas-memory-rebuild'

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
  if (inputKind === 'driving') {
    noteTerminalWebglAtlasTyping()
  }
  // sendInput only queues writes; await sendInputAccepted so paste chunking respects PTY backpressure.
  const accepted = signal
    ? transport.sendInputAccepted?.(data, inputKind, { signal })
    : transport.sendInputAccepted?.(data, inputKind)
  return accepted ?? transport.sendInput(data, inputKind)
}
