import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { readDashboardClientHost } from '../dashboard/dashboard-client-host'
import { resolveDashboardCardTerminalInput } from '../dashboard/dashboard-card-terminal-input'

export type CanvasAgentCard = DashboardCard & { canvasStatusUnknown?: boolean }

export function useCanvasWorkspaceCards(tab: Tab, snapshot: DashboardSnapshot): CanvasAgentCard[] {
  const terminals = useAppStore((state) => state.tabsByWorktree[tab.worktreeId])
  const layouts = useAppStore((state) => state.terminalLayoutsByTabId)
  const liveIds = useAppStore((state) => state.ptyIdsByTabId)
  const unifiedTabs = useAppStore((state) => state.unifiedTabsByWorktree[tab.worktreeId])
  return useMemo(() => {
    const cards: CanvasAgentCard[] = snapshot.cards.filter(
      (card) => card.worktreeId === tab.worktreeId && card.executionHostId === tab.executionHostId
    )
    const workspace = snapshot.workspaces?.find(
      (item) => item.worktreeId === tab.worktreeId && item.executionHostId === tab.executionHostId
    )
    if (!workspace) {
      return cards
    }
    const client = readDashboardClientHost()
    const state = useAppStore.getState()
    for (const terminal of terminals ?? []) {
      if (!terminal.launchAgent || cards.some((card) => card.tabId === terminal.id)) {
        continue
      }
      const owner = unifiedTabs?.find(
        (item) => item.contentType === 'terminal' && item.entityId === terminal.id
      )
      const executionHostId =
        owner?.executionHostId ?? getExecutionHostIdForWorktree(state, tab.worktreeId)
      if (!owner || executionHostId !== tab.executionHostId) {
        continue
      }
      const panes = Object.entries(layouts[terminal.id]?.ptyIdsByLeafId ?? {})
      if (panes.length !== 1) {
        continue
      }
      const [leafId, ptyId] = panes[0]
      if (!ptyId || !liveIds[terminal.id]?.includes(ptyId)) {
        continue
      }
      const paneKey = makePaneKey(terminal.id, leafId)
      cards.push({
        ...workspace,
        paneKey,
        ptyId,
        tabId: terminal.id,
        leafId,
        agentType: terminal.launchAgent,
        bucket: 'idle',
        dotState: 'idle',
        canvasStatusUnknown: true,
        task: '',
        startedAt: terminal.createdAt,
        finishedAt: null,
        stateChangedAt: 0,
        unseen: false,
        terminalInput: resolveDashboardCardTerminalInput(state, {
          ptyId,
          worktreeId: tab.worktreeId,
          paneKey,
          cwd: terminal.startupCwd ?? state.getKnownWorktreeById(tab.worktreeId)?.path ?? '',
          shellOverride: terminal.shellOverride,
          launchAgent: terminal.launchAgent,
          clientPlatform: client.platform,
          userAgent: client.userAgent,
          osRelease: client.osRelease
        })
      })
    }
    return cards
  }, [tab.worktreeId, tab.executionHostId, snapshot, terminals, layouts, liveIds, unifiedTabs])
}
