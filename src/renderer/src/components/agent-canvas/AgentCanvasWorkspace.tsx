import { useCallback, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { GitBranch, Folder, Network } from 'lucide-react'
import { useAppStore } from '@/store'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import {
  buildTabAgentLaunchOptions,
  orderTabLaunchAgents
} from '../tab-bar/tab-agent-launch-options'
import { useLiveDashboardSnapshot } from '../dashboard/useLiveDashboardSnapshot'
import { revealDashboardAgent } from '../dashboard/reveal-dashboard-agent'
import { openWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-open'
import { getActiveExecutionHostIdForWorktree } from '@/lib/unified-tab-host-ownership'
import { translate } from '@/i18n/i18n'
import type { Tab } from '../../../../shared/tab-types'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentCanvasBoard } from './AgentCanvasBoard'
import { launchCanvasAgent } from './launch-canvas-agent'
import { useCanvasWorkspaceCards } from './use-canvas-workspace-cards'
import { CanvasBrowserContext } from './AgentCanvasBrowser'

export default function AgentCanvasWorkspace({ tab }: { tab: Tab }) {
  const snapshot = useLiveDashboardSnapshot()
  const settings = useAppStore((state) => state.settings)
  const target = useAgentDetectionTargetForWorktree(tab.worktreeId)
  const { detectedIds } = useDetectedAgents(target)
  const workspace = snapshot.workspaces?.find(
    (item) => item.worktreeId === tab.worktreeId && item.executionHostId === tab.executionHostId
  )
  const cards = useCanvasWorkspaceCards(tab, snapshot)
  const launchOptions = useMemo(
    () =>
      buildTabAgentLaunchOptions(
        orderTabLaunchAgents(
          settings?.defaultTuiAgent,
          detectedIds ?? [],
          settings?.disabledTuiAgents
        ),
        settings?.agentCmdOverrides
      ),
    [
      settings?.defaultTuiAgent,
      settings?.disabledTuiAgents,
      settings?.agentCmdOverrides,
      detectedIds
    ]
  )
  const launch = useCallback((agent: TuiAgent) => launchCanvasAgent(tab, agent), [tab])
  const reveal = useCallback((card: DashboardCard) => {
    revealDashboardAgent({
      worktreeId: card.worktreeId,
      executionHostId: card.executionHostId,
      repoId: card.repoId,
      tabId: card.tabId,
      leafId: card.leafId
    })
  }, [])
  const openBrowser = useCallback(
    async (input: string) => {
      const url = new URL(input)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Enter an HTTP or HTTPS URL.')
      }
      const state = useAppStore.getState()
      if (
        state.activeWorktreeId !== tab.worktreeId ||
        getActiveExecutionHostIdForWorktree(state, tab.worktreeId) !== tab.executionHostId
      ) {
        throw new Error('Select this canvas workspace before opening a browser.')
      }
      const created: { id: string | null } = { id: null }
      await openWorkspaceBrowserTab({
        workspaceId: tab.worktreeId,
        targetGroupId: tab.groupId,
        url: url.href,
        intent: { kind: 'url' },
        focusOnCreate: false,
        selectWorktree: false,
        onCreated: (id) => {
          created.id = id
        }
      })
      if (!created.id) {
        throw new Error('The browser page is not available yet.')
      }
      return created.id
    },
    [tab.worktreeId, tab.executionHostId, tab.groupId]
  )
  const browserContext = useMemo(
    () => ({
      worktreeId: tab.worktreeId,
      executionHostId: tab.executionHostId,
      create: openBrowser
    }),
    [tab.worktreeId, tab.executionHostId, openBrowser]
  )
  const scope = JSON.stringify(['workspace-tab', tab.executionHostId, tab.worktreeId, tab.id])
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-workspace-canvas={tab.id}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-xs">
        <span className="flex items-center gap-2 font-medium">
          <Network className="size-4" />
          {tab.customLabel || translate('agentCanvas.canvas', 'Canvas')}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Folder className="size-3.5 shrink-0" />
          {workspace?.repoName ?? tab.worktreeId}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <GitBranch className="size-3.5" />
          {workspace?.worktreeName ?? tab.worktreeId}
        </span>
        <span className="ml-auto text-muted-foreground">
          {workspace?.hostLabel ?? tab.executionHostId}
        </span>
      </div>
      <CanvasBrowserContext.Provider value={browserContext}>
        <ReactFlowProvider>
          <AgentCanvasBoard
            scope={scope}
            cards={cards}
            onReveal={reveal}
            launchOptions={launchOptions}
            onLaunchAgent={launch}
          />
        </ReactFlowProvider>
      </CanvasBrowserContext.Provider>
    </div>
  )
}
