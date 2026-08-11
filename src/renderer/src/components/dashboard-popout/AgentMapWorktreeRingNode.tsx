import { memo, useState, type MutableRefObject } from 'react'
import { Plus } from 'lucide-react'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import type { DashboardCard, DashboardSpawnAgentArgs } from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/types'
import type {
  AgentMapAgentNode,
  AgentMapProjectRing,
  AgentMapWorktreeRing
} from './agent-map-layout'
import { AGENT_MAP_LINEAGE_RELATION, shouldAggregateAgentMapWorktree } from './agent-map-layout'
import { agentMapDirectLineageChevronPath } from './agent-map-lineage-chevron-path'
import { agentMapWorktreeActiveStatus } from './agent-map-worktree-active-status'

type AgentMapWorktreeRingNodeProps = {
  project: AgentMapProjectRing
  worktree: AgentMapWorktreeRing
  zoom: number
  mapScale: number
  /** Pressed at the start of a pan drag; keeps the ring lit through the gesture. */
  held: boolean
  selectedPaneKey: string | null
  allowAggregation: boolean
  showOrchestrationLinks: boolean
  launchableAgents?: readonly TuiAgent[]
  nodeRefs: MutableRefObject<Map<string, SVGGElement>>
  onSelectAgent: (card: DashboardCard) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onOpenWorkspaceContextMenu?: (
    event: React.MouseEvent<SVGCircleElement>,
    worktree: AgentMapWorktreeRing
  ) => void
  onLabelHoverChange: (worktreeId: string, active: boolean) => void
  onLabelFocusChange: (worktreeId: string, active: boolean) => void
  onAgentKeyDown: (event: React.KeyboardEvent<SVGGElement>, agent: AgentMapAgentNode) => void
}

function formatDuration(minutes: number): string {
  if (minutes < 1) {
    return translate('dashboardPopout.card.time.justNow', 'just now')
  }
  if (minutes < 60) {
    return translate('dashboardPopout.card.time.minutes', '{{count}}m', {
      count: Math.floor(minutes)
    })
  }
  return translate('dashboardPopout.card.time.hours', '{{count}}h', {
    count: Math.floor(minutes / 60)
  })
}

function lineagePath(parent: AgentMapAgentNode, child: AgentMapAgentNode): string {
  return agentMapDirectLineageChevronPath(parent, child)
}

function agentName(card: DashboardCard): string {
  return card.conversationName ?? (card.task.trim() || card.agentType)
}

export function agentMapAttentionMarkerScale(mapScale: number): number {
  const inverseScale = 1 / Math.max(mapScale, 0.001)
  return Math.max(1, inverseScale ** 0.72, inverseScale * 0.5)
}

function WorktreeDetails({
  project,
  worktree,
  launchableAgents,
  onSelectAgent,
  onSpawnAgent,
  onDone
}: Pick<
  AgentMapWorktreeRingNodeProps,
  'project' | 'worktree' | 'launchableAgents' | 'onSelectAgent' | 'onSpawnAgent'
> & {
  onDone: () => void
}): React.JSX.Element {
  const activeCount =
    worktree.statusCounts.working + worktree.statusCounts.blocked + worktree.statusCounts.waiting
  return (
    <PopoverContent align="center" sideOffset={10} className="w-80 p-0">
      <header className="border-b border-border px-3 py-2.5">
        <span className="block truncate text-[11px] text-muted-foreground">{project.name}</span>
        <strong className="block truncate text-[13px]">{worktree.name}</strong>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {translate(
            'dashboardPopout.map.worktreeSummary',
            '{{total}} agents · {{active}} active · {{done}} done',
            {
              count: worktree.agents.length,
              defaultValue_one: '{{total}} agent · {{active}} active · {{done}} done',
              defaultValue_other: '{{total}} agents · {{active}} active · {{done}} done',
              total: worktree.agents.length,
              active: activeCount,
              done: worktree.statusCounts.done
            }
          )}
        </span>
      </header>
      <section className={onSpawnAgent ? 'border-b border-border px-2 py-2' : 'px-2 py-2'}>
        <h3 className="mb-1 px-1 text-[11px] font-semibold text-muted-foreground">
          {translate('dashboardPopout.map.runningAgents', 'Agents')}
        </h3>
        <div className="scrollbar-sleek max-h-56 space-y-0.5 overflow-y-auto">
          {worktree.agents.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {translate('dashboardPopout.map.noWorkspaceAgents', 'No agents in this workspace.')}
            </p>
          ) : (
            worktree.agents.map((agent) => (
              <button
                key={agent.card.paneKey}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  onSelectAgent(agent.card)
                  onDone()
                }}
              >
                <AgentIcon agent={agentTypeToIconAgent(agent.card.agentType)} size={14} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">
                    {agentName(agent.card)}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {agentStateLabel(agent.status)} · {formatDuration(agent.durationMinutes)}
                  </span>
                </span>
                <AgentStateDot state={agent.status} size="md" />
              </button>
            ))
          )}
        </div>
      </section>
      {onSpawnAgent ? (
        <section className="px-3 py-2.5">
          <h3 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
            {translate('dashboardPopout.map.spawnAgent', 'Start a new agent')}
          </h3>
          {launchableAgents && launchableAgents.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {launchableAgents.map((agent) => (
                <Button
                  key={agent}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="gap-1.5"
                  onClick={() => {
                    onSpawnAgent({ worktreeId: worktree.worktreeId, agent })
                    onDone()
                  }}
                >
                  <Plus className="size-3" />
                  <AgentIcon agent={agent} size={12} />
                  {getAgentLabel(agent)}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {translate('dashboardPopout.map.noLaunchableAgents', 'No enabled agents detected.')}
            </p>
          )}
        </section>
      ) : null}
    </PopoverContent>
  )
}

export const AgentMapWorktreeRingNode = memo(function AgentMapWorktreeRingNode({
  project,
  worktree,
  zoom,
  mapScale,
  held,
  selectedPaneKey,
  allowAggregation,
  showOrchestrationLinks,
  launchableAgents,
  nodeRefs,
  onSelectAgent,
  onSpawnAgent,
  onOpenWorkspaceContextMenu,
  onLabelHoverChange,
  onLabelFocusChange,
  onAgentKeyDown
}: AgentMapWorktreeRingNodeProps): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const exiting = project.motionState === 'exiting' || worktree.motionState === 'exiting'
  const selected = worktree.agents.some((agent) => agent.card.paneKey === selectedPaneKey)
  const activeStatus = agentMapWorktreeActiveStatus(worktree.statusCounts)
  const aggregate = !selected && shouldAggregateAgentMapWorktree(worktree, zoom, allowAggregation)
  const agentsByPaneKey = new Map(worktree.agents.map((agent) => [agent.card.paneKey, agent]))

  return (
    <Popover open={detailsOpen && !exiting} onOpenChange={setDetailsOpen}>
      <g
        className={`agent-map-worktree-group${worktree.motionState ? ` is-${worktree.motionState}` : ''}${held ? ' is-held' : ''}`}
        data-agent-map-worktree-id={worktree.id}
        aria-hidden={exiting || undefined}
        onPointerEnter={() => onLabelHoverChange(worktree.id, true)}
        onPointerLeave={() => onLabelHoverChange(worktree.id, false)}
        onFocus={() => onLabelFocusChange(worktree.id, true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onLabelFocusChange(worktree.id, false)
          }
        }}
      >
        {activeStatus ? (
          <circle
            className={`agent-map-worktree-status-glow fleet-status-${activeStatus}`}
            data-agent-map-worktree-status-glow=""
            data-worktree-active-status={activeStatus}
            cx={worktree.x}
            cy={worktree.y}
            r={worktree.radius}
            aria-hidden="true"
          />
        ) : null}
        <PopoverTrigger asChild>
          <circle
            className={`agent-map-worktree-ring${activeStatus ? ` is-${activeStatus}` : ''}${selected ? ' is-selected' : ''}${detailsOpen ? ' is-open' : ''}`}
            data-agent-map-worktree=""
            data-agent-count={worktree.agents.length}
            cx={worktree.x}
            cy={worktree.y}
            r={worktree.radius}
            role="button"
            tabIndex={exiting ? -1 : 0}
            aria-hidden={exiting || undefined}
            aria-label={
              worktree.workspaceKind === 'folder'
                ? translate(
                    'dashboardPopout.map.openFolderWorkspace',
                    'Open {{workspace}} folder workspace details',
                    { workspace: worktree.name }
                  )
                : translate(
                    'dashboardPopout.map.openWorktree',
                    'Open {{worktree}} worktree details',
                    { worktree: worktree.name }
                  )
            }
            onKeyDown={(event) => {
              if (exiting) {
                return
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setDetailsOpen((open) => !open)
              }
            }}
            onContextMenu={
              onOpenWorkspaceContextMenu && !exiting
                ? (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setDetailsOpen(false)
                    onOpenWorkspaceContextMenu(event, worktree)
                  }
                : undefined
            }
          />
        </PopoverTrigger>
        {aggregate ? (
          <g
            className="agent-map-aggregate-node"
            transform={`translate(${worktree.x} ${worktree.y + 7})`}
          >
            <circle r={Math.min(26, 12 + Math.sqrt(worktree.agents.length) * 2)} />
            <text y={3}>{worktree.agents.length}</text>
          </g>
        ) : (
          <>
            <g className="agent-map-lineage-links" aria-hidden>
              {(showOrchestrationLinks ? worktree.agents : []).map((child) => {
                const parent = child.card.parentPaneKey
                  ? agentsByPaneKey.get(child.card.parentPaneKey)
                  : undefined
                // Why no y-gate: both endpoints are drawn nodes, so the relationship is
                // real whatever the layout ranked them. Suppressing the edge only hid
                // lineage that packing pressure had placed side by side.
                //
                // Self-parents are dropped explicitly — the layout already ignores them
                // (`layoutAgentMapLineage`), and the y-gate used to mask them here by
                // accident since a node never ranks below itself.
                if (!parent || parent.card.paneKey === child.card.paneKey) {
                  return null
                }
                return (
                  <path
                    key={child.card.paneKey}
                    className={`agent-map-lineage-link${child.motionState === 'exiting' || parent.motionState === 'exiting' ? ' is-exiting' : child.motionState === 'entering' || parent.motionState === 'entering' ? ' is-entering' : ''}`}
                    data-agent-map-lineage-link=""
                    data-agent-map-lineage-relation={AGENT_MAP_LINEAGE_RELATION}
                    data-parent-pane-key={parent.card.paneKey}
                    data-child-pane-key={child.card.paneKey}
                    d={lineagePath(parent, child)}
                  />
                )
              })}
            </g>
            {worktree.agents.map((agent) => {
              const iconSize = Math.max(12, Math.min(22, agent.radius * 1.05))
              const agentExiting = exiting || agent.motionState === 'exiting'
              const hasStatusGlow =
                agent.status === 'working' ||
                agent.status === 'waiting' ||
                agent.status === 'blocked'
              return (
                <g
                  key={agent.card.paneKey}
                  ref={(node) => {
                    if (node) {
                      nodeRefs.current.set(agent.card.paneKey, node)
                    } else {
                      nodeRefs.current.delete(agent.card.paneKey)
                    }
                  }}
                  data-agent-map-agent=""
                  data-agent-provider={agent.card.agentType}
                  role="button"
                  tabIndex={agentExiting ? -1 : 0}
                  aria-hidden={agentExiting || undefined}
                  aria-pressed={selectedPaneKey === agent.card.paneKey}
                  aria-label={`${agentName(agent.card)}, ${agentStateLabel(agent.status)}${agent.card.unseen ? ', unread' : ''}, ${formatDuration(agent.durationMinutes)}, ${worktree.name}, ${project.name}`}
                  className={`agent-map-agent-node fleet-status-${agent.status}${selectedPaneKey === agent.card.paneKey ? ' is-selected' : ''}${agent.motionState ? ` is-${agent.motionState}` : ''}`}
                  transform={`translate(${agent.x} ${agent.y})`}
                  onClick={(event) => {
                    if (agentExiting) {
                      return
                    }
                    event.currentTarget.focus()
                    onSelectAgent(agent.card)
                  }}
                  onKeyDown={(event) => {
                    if (!agentExiting) {
                      onAgentKeyDown(event, agent)
                    }
                  }}
                >
                  <g className="agent-map-agent-visual">
                    {hasStatusGlow ? (
                      <circle
                        className={`agent-map-agent-status-glow fleet-status-${agent.status}`}
                        data-agent-map-agent-status-glow=""
                        data-agent-active-status={agent.status}
                        r={agent.radius + 1}
                        aria-hidden="true"
                      />
                    ) : null}
                    <circle className="agent-map-agent-hit" r={Math.max(10, agent.radius + 3)} />
                    <circle className="agent-map-agent-mark" r={agent.radius} />
                    <foreignObject
                      className="agent-map-agent-icon"
                      x={-iconSize / 2}
                      y={-iconSize / 2}
                      width={iconSize}
                      height={iconSize}
                    >
                      <div>
                        <AgentIcon
                          agent={agentTypeToIconAgent(agent.card.agentType)}
                          size={iconSize}
                        />
                      </div>
                    </foreignObject>
                    {/* Unread dot sits ON the ring stroke; its halo breaks the ring around it. */}
                    {agent.card.unseen ? (
                      <circle
                        className="agent-map-agent-unread-mark"
                        data-agent-unread-marker=""
                        cx={-agent.radius * Math.SQRT1_2}
                        cy={-agent.radius * Math.SQRT1_2}
                        r={agent.radius * 0.225 * agentMapAttentionMarkerScale(mapScale)}
                        vectorEffect="none"
                        aria-hidden="true"
                      />
                    ) : null}
                  </g>
                </g>
              )
            })}
          </>
        )}
      </g>
      <WorktreeDetails
        project={project}
        worktree={worktree}
        launchableAgents={launchableAgents}
        onSelectAgent={onSelectAgent}
        onSpawnAgent={onSpawnAgent}
        onDone={() => setDetailsOpen(false)}
      />
    </Popover>
  )
})
