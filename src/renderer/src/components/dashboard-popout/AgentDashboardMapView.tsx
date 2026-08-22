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
import { countAgentMapAgentTypes, filterAgentMapCards } from './agent-map-filter'
import { selectAgentlessMapWorkspaces } from './agent-map-workspace-visibility'
import { AgentMapFilterChips } from './AgentMapFilterChips'
import { AgentMapFilterPanel } from './AgentMapFilterPanel'
import { useAgentMapFilters } from './useAgentMapFilters'

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
  const agentTypes = useMemo(
    () => [...countAgentMapAgentTypes(snapshot.cards).keys()],
    [snapshot.cards]
  )
  const mapFilters = useAgentMapFilters(agentTypes)
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
  // The map's own facets run here so the panel can report one shown-count that
  // matches what the canvas actually draws.
  const visibleCards = useMemo(
    () =>
      filterAgentMapCards({
        cards,
        enabledStates: mapFilters.states,
        enabledHosts: mapFilters.hosts,
        enabledAgentTypes: mapFilters.agentTypes,
        timeRanges: mapFilters.timeRanges,
        orchestrationOnly: mapFilters.orchestrationOnly,
        now
      }).filter((card) => !mapFilters.unreadOnly || card.unseen),
    [
      cards,
      mapFilters.states,
      mapFilters.hosts,
      mapFilters.agentTypes,
      mapFilters.timeRanges,
      mapFilters.orchestrationOnly,
      mapFilters.unreadOnly,
      now
    ]
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
        filteredCount={cards.length}
        query={query}
        onQueryChange={onQueryChange}
        filters={filters}
        onFiltersChange={onFiltersChange}
        searchInputRef={searchInputRef}
        filterControl={
          <AgentMapFilterPanel
            cards={snapshot.cards}
            shownCount={visibleCards.length}
            filterOptions={snapshot.filterOptions}
            filters={filters}
            onFiltersChange={onFiltersChange}
            map={mapFilters}
            agentlessWorkspaceCount={agentlessWorkspaces.length}
            showAgentlessWorkspaces={showAgentlessWorkspaces}
            onShowAgentlessWorkspacesChange={setShowAgentlessWorkspaces}
            showOrchestrationLinks={showOrchestrationLinks}
            onShowOrchestrationLinksChange={setShowOrchestrationLinks}
          />
        }
      />
      <AgentMapFilterChips
        map={mapFilters}
        filters={filters}
        onFiltersChange={onFiltersChange}
        projectLabel={(id) => snapshot.cards.find((card) => card.repoId === id)?.repoName ?? id}
        statusLabel={(id) =>
          snapshot.cards.find((card) => card.workspaceStatusId === id)?.workspaceStatusLabel ?? id
        }
        showAgentlessWorkspaces={showAgentlessWorkspaces}
        onShowAgentlessWorkspacesChange={setShowAgentlessWorkspaces}
        showOrchestrationLinks={showOrchestrationLinks}
        onShowOrchestrationLinksChange={setShowOrchestrationLinks}
        onClear={() => {
          onFiltersChange(EMPTY_DASHBOARD_FILTERS)
          mapFilters.reset()
          setShowAgentlessWorkspaces(false)
          setShowOrchestrationLinks(true)
        }}
      />
      <div className={cn('flex min-h-0 flex-1', dialogCard && 'flex-row-reverse')}>
        <Suspense fallback={null}>
          <AgentMap
            cards={visibleCards}
            workspaces={visibleAgentlessWorkspaces}
            repoIconsByRepoId={snapshot.repoIconsByRepoId}
            now={now}
            className={dialogCard ? 'w-1/2 flex-none' : undefined}
            selectedPaneKey={dialogCard?.paneKey}
            enabledHosts={mapFilters.hosts}
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
