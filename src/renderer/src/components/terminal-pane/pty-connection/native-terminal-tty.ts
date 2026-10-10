import { parseExecutionHostId } from '../../../../../shared/execution-host'
import type { PtyTransport } from '../pty-transport-types'

// Secure Keyboard Entry reads the pty's termios, which only a pty on this Mac exposes: an SSH
// or runtime pty lives on another host, so those panes never bind one.
export function bindNativeTerminalLocalPty(
  transport: PtyTransport,
  surfaceId: number,
  ptyId: string
): void {
  if (
    transport.getConnectionId?.() ||
    transport.getRuntimeEnvironmentId?.() ||
    parseExecutionHostId(transport.getExecutionHostId?.())?.kind !== 'local'
  ) {
    return
  }
  window.api?.nativeTerminal?.bindLocalPty(surfaceId, ptyId)
}
