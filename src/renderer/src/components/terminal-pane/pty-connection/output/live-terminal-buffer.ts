import { installTerminalLiveScrollbackRestore } from '@/lib/pane-manager/terminal-live-scrollback-restore'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindLiveTerminalBuffer(session: ConnectPanePtySession): void {
  // Observe CSI 3 J inside xterm parse so split redraws report once with current rows already applied.
  session.liveScrollbackRestore?.dispose()
  session.liveScrollbackRestore = installTerminalLiveScrollbackRestore(session.pane.terminal)

  // Switch buffers only on mismatch: repeated ?1049 still restores cursor and swaps Kitty slots. Read parsed state best-effort; draining first can stall recovery and break cancellation.
  session.isPaneOnAlternateScreen = function (): boolean {
    return session.pane.terminal.buffer.active.type === 'alternate'
  }
}
