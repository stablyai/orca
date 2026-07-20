import type { RunTerminalCommandDetail } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'

type HandleTerminalProgrammaticCommandRunArgs = {
  detail: RunTerminalCommandDetail | undefined
  tabId: string
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
}

// Why: re-running a reuse-enabled quick command sends its command into the
// terminal it already spawned. We write raw PTY input (not bracketed paste) so
// the trailing `\r` runs the command instead of landing as literal text.
export function handleTerminalProgrammaticCommandRun({
  detail,
  tabId,
  getManager,
  getPaneTransports
}: HandleTerminalProgrammaticCommandRunArgs): void {
  if (!detail?.tabId || detail.tabId !== tabId || !detail.input) {
    return
  }
  const manager = getManager()
  if (!manager) {
    return
  }
  const panes = manager.getPanes()
  const paneTransports = getPaneTransports()

  // Why: the reuse path probed one specific PTY for idleness, so re-run against
  // the pane that owns that exact PTY. Targeting the active pane instead could
  // land the command in a different (possibly busy) split pane than the one that
  // passed the idle check. With no ptyId we fall back to the active pane, where a
  // typed command would go.
  const pane = detail.ptyId
    ? (panes.find((candidate) => paneTransports.get(candidate.id)?.getPtyId() === detail.ptyId) ??
      null)
    : (manager.getActivePane() ?? panes[0] ?? null)
  if (!pane) {
    return
  }
  const transport = paneTransports.get(pane.id)
  if (!transport) {
    return
  }

  const sent = transport.sendInput(detail.input)
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
}
