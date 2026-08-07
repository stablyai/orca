import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  DashboardCard,
  DashboardCardHostKind,
  DashboardSleepWorkspaceArgs,
  DashboardSpawnAgentArgs,
  DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import type { TuiAgent } from '../../../../shared/types'
import { AgentMapCanvas, type AgentMapCanvasHandle } from './AgentMapCanvas'
import {
  filterAgentMapCards,
  type AgentMapState,
  type AgentMapHostFilter
} from './agent-map-filter'
import { updateAgentMapLayout, type AgentMapLayoutCache } from './agent-map-layout'
import './agent-map.css'

type AgentMapProps = {
  cards: DashboardCard[]
  workspaces?: DashboardWorkspace[]
  repoIconsByRepoId?: Record<string, RepoIcon | null>
  now: number
  className?: string
  compact?: boolean
  selectedPaneKey?: string | null
  /** Owned by the board so the shared toolbar filter can drive it. Defaults to
   *  every state, i.e. the map shows whatever it is handed. */
  enabledStates?: ReadonlySet<AgentMapState>
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  workspaceContextMenusEnabled?: boolean
  onWorkspaceContextMenuOpenChange?: (open: boolean) => void
  onOpenTerminal: (card: DashboardCard) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onSleepWorkspace?: (args: DashboardSleepWorkspaceArgs) => void
}

const HOST_FILTERS: AgentMapHostFilter[] = ['all', 'local', 'ssh', 'wsl', 'remote']
const ALL_AGENT_STATES: ReadonlySet<AgentMapState> = new Set<AgentMapState>([
  'attention',
  'working',
  'done',
  'idle'
])
const EMPTY_WORKSPACES: DashboardWorkspace[] = []

function hostFilterLabel(filter: AgentMapHostFilter): string {
  switch (filter) {
    case 'all':
      return translate('dashboardPopout.map.host.all', 'All hosts')
    case 'local':
      return translate('dashboardPopout.map.host.local', 'Local')
    case 'ssh':
      return translate('dashboardPopout.map.host.ssh', 'SSH')
    case 'wsl':
      return translate('dashboardPopout.map.host.wsl', 'WSL')
    case 'remote':
      return translate('dashboardPopout.map.host.remote', 'Remote')
  }
}

export function AgentMap({
  cards,
  workspaces = EMPTY_WORKSPACES,
  repoIconsByRepoId,
  now,
  className,
  compact = false,
  selectedPaneKey = null,
  enabledStates = ALL_AGENT_STATES,
  launchableAgentsByWorktreeId,
  workspaceContextMenusEnabled = false,
  onWorkspaceContextMenuOpenChange,
  onOpenTerminal,
  onSpawnAgent,
  onSleepWorkspace
}: AgentMapProps): React.JSX.Element {
  const canvasRef = useRef<AgentMapCanvasHandle>(null)
  const layoutCacheRef = useRef<AgentMapLayoutCache | null>(null)
  const [hostFilter, setHostFilter] = useState<AgentMapHostFilter>('all')
  const hostCounts = useMemo(() => {
    const counts: Record<DashboardCardHostKind, number> = {
      local: 0,
      ssh: 0,
      wsl: 0,
      remote: 0
    }
    for (const card of cards) {
      counts[card.hostKind ?? 'local'] += 1
    }
    for (const workspace of workspaces) {
      counts[workspace.hostKind] += 1
    }
    return counts
  }, [cards, workspaces])
  const visibleCards = useMemo(
    () =>
      filterAgentMapCards({
        cards,
        enabledStates,
        hostFilter
      }),
    [cards, enabledStates, hostFilter]
  )
  const visibleWorkspaces = useMemo(
    () =>
      hostFilter === 'all'
        ? workspaces
        : workspaces.filter((workspace) => workspace.hostKind === hostFilter),
    [hostFilter, workspaces]
  )
  const layoutResult = useMemo(
    () => updateAgentMapLayout(layoutCacheRef.current, visibleCards, now, visibleWorkspaces),
    [visibleCards, visibleWorkspaces, now]
  )
  useEffect(() => {
    layoutCacheRef.current = layoutResult.cache
  }, [layoutResult.cache])
  const layout = layoutResult.layout

  return (
    <section className={cn('flex min-h-0 flex-1', className)}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-3 py-2">
          <strong className="min-w-0 truncate text-xs">
            {translate(
              'dashboardPopout.map.filters.canvasSummary',
              '{{shown}} of {{total}} agents shown',
              {
                shown: visibleCards.length,
                total: cards.length
              }
            )}
          </strong>
          {!compact ? (
            <div
              className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5"
              role="group"
              aria-label={translate('dashboardPopout.map.hostFilter', 'Host filter')}
            >
              {HOST_FILTERS.filter((option) => option === 'all' || hostCounts[option] > 0).map(
                (option) => (
                  <Button
                    key={option}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={hostFilter === option}
                    onClick={() => setHostFilter(option)}
                    className={cn(
                      'h-6 px-2 text-[10px]',
                      hostFilter === option && 'bg-accent text-accent-foreground'
                    )}
                  >
                    {hostFilterLabel(option)}
                  </Button>
                )
              )}
            </div>
          ) : null}
        </header>
        <AgentMapCanvas
          ref={canvasRef}
          layout={layout}
          repoIconsByRepoId={repoIconsByRepoId}
          selectedPaneKey={selectedPaneKey}
          allowAggregation
          launchableAgentsByWorktreeId={launchableAgentsByWorktreeId}
          workspaceContextMenusEnabled={workspaceContextMenusEnabled}
          onWorkspaceContextMenuOpenChange={onWorkspaceContextMenuOpenChange}
          onSelectAgent={onOpenTerminal}
          onSpawnAgent={onSpawnAgent}
          onSleepWorkspace={onSleepWorkspace}
        />
      </div>
    </section>
  )
}
