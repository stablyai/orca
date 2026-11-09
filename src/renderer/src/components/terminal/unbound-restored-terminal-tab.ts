import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'

export type UnboundRestoredTabState = Pick<
  AppState,
  'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'pendingStartupByTabId'
>

/**
 * A saved tab with no PTY anywhere and nothing queued to start. Mounting it hidden would only start a
 * fresh shell or a fresh agent nobody asked for; with many such tabs one worktree activation can
 * exhaust the host's process limit (#39166). These wait until shown, or for the capped idle admission.
 */
export function isUnboundRestoredTerminalTab(
  tab: Pick<
    TerminalTab,
    'id' | 'ptyId' | 'launchAgent' | 'restoredFromSession' | 'agentLaunchPane'
  >,
  state: UnboundRestoredTabState
): boolean {
  // Tabs created this session carry neither marker, so their hidden starts keep mounting as before.
  if (tab.restoredFromSession !== true && !tab.launchAgent) {
    return false
  }
  if (tab.ptyId || tab.agentLaunchPane || state.pendingStartupByTabId[tab.id] !== undefined) {
    return false
  }
  if (tabHasLivePty(state.ptyIdsByTabId, tab.id)) {
    return false
  }
  // A saved leaf binding may still reattach to a live session, so it keeps the existing mount path.
  const leafPtyIds = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
  return !leafPtyIds || Object.values(leafPtyIds).every((ptyId) => !ptyId)
}
