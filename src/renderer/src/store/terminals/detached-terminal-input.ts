import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveDashboardCardTerminalInput,
  type DashboardCardTerminalInputState
} from '@/components/dashboard/dashboard-card-terminal-input'
import { readDashboardClientHost } from '@/components/dashboard/dashboard-client-host'
import type { AppState } from '../types'

/** The tab, its layout and its worktree path, plus whatever dashboard input slices the store holds. */
export type DetachedTerminalInputState = Partial<DashboardCardTerminalInputState> &
  Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'> & {
    allWorktrees: () => readonly { id: string; path: string }[]
  }

/** The pane's host-input facts for its companion window, resolved as the dashboard resolves a card's. */
export function resolveDetachedTerminalInput(
  state: DetachedTerminalInputState,
  tabId: string,
  ptyId: string
): DashboardCardTerminalInput | null {
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  if (!tab) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafId =
    Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
      ([, leafPtyId]) => leafPtyId === ptyId
    )?.[0] ?? layout?.activeLeafId
  const clientHost = readDashboardClientHost()
  return resolveDashboardCardTerminalInput(state, {
    ptyId,
    worktreeId: tab.worktreeId,
    // Why: without a stable leaf no agent evidence is keyed to the pane, so its input stays the shell's.
    paneKey:
      leafId && isTerminalLeafId(leafId) && !tabId.includes(':')
        ? makePaneKey(tabId, leafId)
        : tabId,
    cwd:
      tab.startupCwd ??
      state.allWorktrees().find((worktree) => worktree.id === tab.worktreeId)?.path ??
      '',
    shellOverride: tab.shellOverride,
    launchAgent: tab.launchAgent,
    clientPlatform: clientHost.platform,
    userAgent: clientHost.userAgent,
    osRelease: clientHost.osRelease
  })
}
