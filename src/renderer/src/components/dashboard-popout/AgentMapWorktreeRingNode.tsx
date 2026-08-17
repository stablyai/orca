import { memo, useState, type MutableRefObject } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import type {
  DashboardCard,
  DashboardRevealWorktreeArgs,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentMapAgentNode,
  AgentMapProjectRing,
  AgentMapWorktreeRing
} from './agent-map-layout'
import { AGENT_MAP_LINEAGE_RELATION, shouldAggregateAgentMapWorktree } from './agent-map-layout'
import { AgentMapQuestionMarker } from './AgentMapQuestionMarker'
import type { AgentMapFlareStatus } from './agent-map-node-metadata'
import {
  agentMapAttentionMarkerScale,
  agentMapStatusLabel,
  agentName,
  formatDuration,
  lineagePath
} from './agent-map-node-presentation'
import { agentMapWorktreeActiveStatus } from './agent-map-worktree-active-status'
import { AgentMapWorktreeDetailsCard } from './AgentMapWorktreeDetailsCard'

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
  recentFlareStatuses: ReadonlyMap<string, AgentMapFlareStatus>
  launchableAgents?: readonly TuiAgent[]
  nodeRefs: MutableRefObject<Map<string, SVGGElement>>
  onSelectAgent: (card: DashboardCard) => void
  onRevealWorktree?: (args: DashboardRevealWorktreeArgs) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onOpenWorkspaceContextMenu?: (
    event: React.MouseEvent<SVGCircleElement>,
    worktree: AgentMapWorktreeRing
  ) => void
  onLabelHoverChange: (worktreeId: string, active: boolean) => void
  onLabelFocusChange: (worktreeId: string, active: boolean) => void
  onAgentKeyDown: (event: React.KeyboardEvent<SVGGElement>, agent: AgentMapAgentNode) => void
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
  recentFlareStatuses,
  launchableAgents,
  nodeRefs,
  onSelectAgent,
  onRevealWorktree,
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
              const flareStatus = recentFlareStatuses.get(agent.card.paneKey)
              // `done` here is the unread finish only — `done-seen` demotes to a bare
              // emerald ring so the halo keeps meaning "this one is still unread".
              const hasStatusGlow =
                agent.status === 'working' ||
                agent.status === 'waiting' ||
                agent.status === 'blocked' ||
                agent.status === 'done'
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
                  aria-label={`${agentName(agent.card)}, ${agentMapStatusLabel(agent.status)}${agent.card.unseen ? ', unread' : ''}, ${formatDuration(agent.durationMinutes)}, ${worktree.name}, ${project.name}`}
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
                    {/* One-shot ripple for fresh questions and finishes. */}
                    {flareStatus && !agentExiting ? (
                      <circle
                        className={`agent-map-agent-status-flare fleet-status-${flareStatus}`}
                        data-agent-map-agent-status-flare=""
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
                    {agent.status === 'waiting' ? (
                      <AgentMapQuestionMarker
                        radius={agent.radius}
                        markerScale={agentMapAttentionMarkerScale(mapScale)}
                      />
                    ) : null}
                  </g>
                </g>
              )
            })}
          </>
        )}
      </g>
      <AgentMapWorktreeDetailsCard
        project={project}
        worktree={worktree}
        launchableAgents={launchableAgents}
        onSelectAgent={onSelectAgent}
        onRevealWorktree={onRevealWorktree}
        onSpawnAgent={onSpawnAgent}
        onDone={() => setDetailsOpen(false)}
      />
    </Popover>
  )
})
