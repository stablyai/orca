import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { FreshSpawnOptions } from '../startup/fresh-spawn-types'
import { holdRetainedTerminalHistory } from '../reattach/retained-terminal-history'

export function prepareFreshSpawnImage(
  session: ConnectPanePtySession,
  options: FreshSpawnOptions
): void {
  session.authoritativeReattachGeneration += 1
  // Every connect creates/rebinds ownership; legacy replies lacking incarnationId cannot inherit the old fence.
  session.remotePtyIncarnationId = null
  if (session.deps.restoredViewportBlankingPanesRef?.current.has(session.pane.id)) {
    const savedId =
      session.deps.restoredPtyIdByLeafId?.[session.deps.restoredLeafId ?? session.pane.leafId] ??
      session.tab?.ptyId ??
      null
    holdRetainedTerminalHistory(session, savedId).painted = true
  }
  session.clearPaneMode2031State()
  session.clearHiddenOutputRestoreState()
  // Cancelled replay can retain isUserScrolling; replacement shells must start following output.
  const prepareFreshImage = (): void => {
    session.resetFreshSpawnFollowOutput()
    session.groundInputModesForNewProcess()
    session.prepareFreshShellViewportForSpawn(options)
  }
  if (session.retainedTerminalHistory) {
    session.retainedTerminalHistory.prepareFresh = prepareFreshImage
  } else {
    prepareFreshImage()
  }
}
