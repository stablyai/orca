import { discardPreHandlerPtyState } from '../../pty-transport/delivery/pty-pre-handler-buffer'
import '../../pty-transport/delivery/pty-dispatcher'
import { unregisterPtyDataHandlers } from '../../pty-transport/shutdown/pty-shutdown-data-suspension'
import { disposeParkedTerminalWatchersForPtyIds } from '../../parking/output-watchers/terminal-parked-watcher-registry'

export function reapUnboundCodexPty(ptyId: string, reason: string): void {
  try {
    void window.api.pty.kill(ptyId).catch((err) => {
      console.warn(`[codex-restart] failed to reap ${reason}:`, err)
    })
  } catch (err) {
    console.warn(`[codex-restart] failed to reap ${reason}:`, err)
  }
  discardPreHandlerPtyState(ptyId)
}

export function releaseReplacedCodexPanePty(ptyId: string): void {
  // Dispose parked watchers before an unlabeled exit could collapse the rebound leaf or close its tab.
  disposeParkedTerminalWatchersForPtyIds([ptyId])
  for (const snapshot of unregisterPtyDataHandlers([ptyId])) {
    snapshot.commit()
  }
  discardPreHandlerPtyState(ptyId)
}

export function killReplacedCodexPanePty(ptyId: string): void {
  releaseReplacedCodexPanePty(ptyId)
  reapUnboundCodexPty(ptyId, 'replaced Codex pane PTY')
}
