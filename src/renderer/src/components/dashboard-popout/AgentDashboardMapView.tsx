import { Suspense, useMemo, useState, type RefObject } from 'react'
import type {
  DashboardCard,
  DashboardSleepWorkspaceArgs,
  DashboardSnapshot,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import { cn } from '@/lib/utils'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { AgentDashboardToolbar } from './AgentDashboardToolbar'
import { AgentTerminalPanel, type AgentRevealArgs } from './AgentTerminalDialog'
import {
  EMPTY_DASHBOARD_FILTERS,
  filterDashboardWorkspaces,
  type DashboardFilters
} from './agent-board-filtering'
import { selectAgentlessMapWorkspaces } from './agent-map-workspace-visibility'
import { useAgentMapStateFilter } from './useAgentMapStateFilter'

const AgentMap = lazyWithRetry(
  () => import('./AgentMap').then((module) => ({ default: module.AgentMap })),
  { reloadKey: 'agent-map' }
)

type AgentDashboardMapViewProps = {
  snapshot: DashboardSnapshot
  cards: DashboardCard[]
  query: string
  onQueryChange: (query: string) => void
  filters: DashboardFilters
  onFiltersChange: (filters: DashboardFilters) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  now: number
  dialogCard: DashboardCard | null
  onDialogOpenChange: (open: boolean) => void
  onRevealAgent: (args: AgentRevealArgs) => void
  onOpenTerminal: (card: DashboardCard) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onSleepWorkspace?: (args: DashboardSleepWorkspaceArgs) => void
  workspaceContextMenusEnabled: boolean
  onWorkspaceContextMenuOpenChange?: (open: boolean) => void
}

/** Map-only state and derivation stay in the pop-out's lazy chunk. */
export function AgentDashboardMapView({
  snapshot,
  cards,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  searchInputRef,
  now,
  dialogCard,
  onDialogOpenChange,
  onRevealAgent,
  onOpenTerminal,
  onSpawnAgent,
  onSleepWorkspace,
  workspaceContextMenusEnabled,
  onWorkspaceContextMenuOpenChange
}: AgentDashboardMapViewProps): React.JSX.Element {
  const { agentStates, toggleAgentState, resetAgentStates } = useAgentMapStateFilter()
  const [showAgentlessWorkspaces, setShowAgentlessWorkspaces] = useState(false)
  const [showOrchestrationLinks, setShowOrchestrationLinks] = useState(true)
  const agentlessWorkspaces = useMemo(
    () =>
      selectAgentlessMapWorkspaces({
        cards: snapshot.cards,
        workspaces: snapshot.workspaces ?? [],
        query: '',
        filters: EMPTY_DASHBOARD_FILTERS
      }),
    [snapshot.cards, snapshot.workspaces]
  )
  const visibleAgentlessWorkspaces = useMemo(
    () =>
      showAgentlessWorkspaces ? filterDashboardWorkspaces(agentlessWorkspaces, query, filters) : [],
    [agentlessWorkspaces, filters, query, showAgentlessWorkspaces]
  )

  return (
    <>
      <AgentDashboardToolbar
        cards={snapshot.cards}
        filterOptions={snapshot.filterOptions}
        filteredCount={cards.length}
        query={query}
        onQueryChange={onQueryChange}
        filters={filters}
        onFiltersChange={onFiltersChange}
        agentStates={agentStates}
        onAgentStateToggle={toggleAgentState}
        onAgentStatesReset={resetAgentStates}
        showAgentlessWorkspaces={showAgentlessWorkspaces}
        agentlessWorkspaceCount={agentlessWorkspaces.length}
        onShowAgentlessWorkspacesChange={setShowAgentlessWorkspaces}
        showOrchestrationLinks={showOrchestrationLinks}
        onShowOrchestrationLinksChange={setShowOrchestrationLinks}
        searchInputRef={searchInputRef}
      />
      <div className={cn('flex min-h-0 flex-1', dialogCard && 'flex-row-reverse')}>
        <Suspense fallback={null}>
          <AgentMap
            cards={cards}
            workspaces={visibleAgentlessWorkspaces}
            repoIconsByRepoId={snapshot.repoIconsByRepoId}
            now={now}
            className={dialogCard ? 'w-1/2 flex-none' : undefined}
            compact={dialogCard !== null}
            selectedPaneKey={dialogCard?.paneKey}
            enabledStates={agentStates}
            showOrchestrationLinks={showOrchestrationLinks}
            launchableAgentsByWorktreeId={snapshot.launchableAgentsByWorktreeId}
            workspaceContextMenusEnabled={workspaceContextMenusEnabled}
            onWorkspaceContextMenuOpenChange={onWorkspaceContextMenuOpenChange}
            onOpenTerminal={onOpenTerminal}
            onSpawnAgent={onSpawnAgent}
            onSleepWorkspace={onSleepWorkspace}
          />
        </Suspense>
        {dialogCard ? (
          <AgentTerminalPanel
            card={dialogCard}
            onOpenChange={onDialogOpenChange}
            onReveal={onRevealAgent}
            className="mr-0 animate-in fade-in-0 slide-in-from-left-2 duration-200 motion-reduce:animate-none"
          />
        ) : null}
      </div>
    </>
  )
}
