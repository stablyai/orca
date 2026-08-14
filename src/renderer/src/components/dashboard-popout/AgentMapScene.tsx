import { memo, useCallback, useMemo, useState, type MutableRefObject } from 'react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { translate } from '@/i18n/i18n'
import type { DashboardCard, DashboardSpawnAgentArgs } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentMapAgentNode,
  AgentMapLayout,
  AgentMapProjectRing,
  AgentMapWorktreeRing
} from './agent-map-layout'
import { AGENT_MAP_LINEAGE_RELATION, shouldAggregateAgentMapWorktree } from './agent-map-layout'
import { selectVisibleAgentMapLabels } from './agent-map-label-declutter'
import { agentMapDirectLineageChevronPath } from './agent-map-lineage-chevron-path'
import type { AgentMapFlareStatus } from './agent-map-node-metadata'
import { AgentMapWorktreeLabel } from './AgentMapWorktreeLabel'
import { AgentMapWorktreeRingNode } from './AgentMapWorktreeRingNode'
import { DashboardHostBadge } from './DashboardHostBadge'

type AgentMapSceneProps = {
  layout: AgentMapLayout
  repoIconsByRepoId?: Record<string, RepoIcon | null>
  zoom: number
  labelScale: number
  mapScale: number
  /** Rings the pointer was pressed in; they stay lit for the whole pan drag. */
  heldProjectId: string | null
  heldWorktreeId: string | null
  selectedPaneKey: string | null
  allowAggregation: boolean
  showOrchestrationLinks: boolean
  recentFlareStatuses: ReadonlyMap<string, AgentMapFlareStatus>
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  nodeRefs: MutableRefObject<Map<string, SVGGElement>>
  onSelectAgent: (card: DashboardCard) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onOpenProjectContextMenu?: (
    event: React.MouseEvent<SVGCircleElement>,
    project: AgentMapProjectRing
  ) => void
  onOpenWorkspaceContextMenu?: (
    event: React.MouseEvent<SVGCircleElement>,
    worktree: AgentMapWorktreeRing
  ) => void
  onAgentKeyDown: (event: React.KeyboardEvent<SVGGElement>, agent: AgentMapAgentNode) => void
}

function worktreeLineagePath(parent: AgentMapWorktreeRing, child: AgentMapWorktreeRing): string {
  const startY = parent.y + parent.radius
  const endY = child.y - child.radius
  const branchY = (startY + endY) / 2
  return `M ${parent.x} ${startY} C ${parent.x} ${branchY} ${child.x} ${branchY} ${child.x} ${endY}`
}

type VisibleAgentLocation = {
  agent: AgentMapAgentNode
  worktreeId: string
}

function agentLineagePath(parent: AgentMapAgentNode, child: AgentMapAgentNode): string {
  return agentMapDirectLineageChevronPath(parent, child)
}

/** Memoization keeps pointer panning to one SVG viewBox write, not a map rerender. */
export const AgentMapScene = memo(function AgentMapScene({
  layout,
  repoIconsByRepoId,
  zoom,
  labelScale,
  mapScale,
  heldProjectId,
  heldWorktreeId,
  selectedPaneKey,
  allowAggregation,
  showOrchestrationLinks,
  recentFlareStatuses,
  launchableAgentsByWorktreeId,
  nodeRefs,
  onSelectAgent,
  onSpawnAgent,
  onOpenProjectContextMenu,
  onOpenWorkspaceContextMenu,
  onAgentKeyDown
}: AgentMapSceneProps): React.JSX.Element {
  const [hoveredWorktreeId, setHoveredWorktreeId] = useState<string | null>(null)
  const [focusedWorktreeId, setFocusedWorktreeId] = useState<string | null>(null)
  const activeWorktreeId = heldWorktreeId ?? hoveredWorktreeId ?? focusedWorktreeId
  const handleLabelHoverChange = useCallback((worktreeId: string, active: boolean): void => {
    setHoveredWorktreeId((current) =>
      active ? worktreeId : current === worktreeId ? null : current
    )
  }, [])
  const handleLabelFocusChange = useCallback((worktreeId: string, active: boolean): void => {
    setFocusedWorktreeId((current) =>
      active ? worktreeId : current === worktreeId ? null : current
    )
  }, [])
  const visibleLabels = useMemo(
    () => selectVisibleAgentMapLabels(layout, labelScale, mapScale),
    [labelScale, layout, mapScale]
  )
  const activeWorktree = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const project of layout.projects) {
      for (const worktree of project.worktrees) {
        if (worktree.id === activeWorktreeId) {
          return worktree
        }
      }
    }
    return null
  }, [activeWorktreeId, layout])
  const visibleAgentsByPaneKey = useMemo(() => {
    const agents = new Map<string, VisibleAgentLocation>()
    for (const project of layout.projects) {
      for (const worktree of project.worktrees) {
        const selected = worktree.agents.some((agent) => agent.card.paneKey === selectedPaneKey)
        if (!selected && shouldAggregateAgentMapWorktree(worktree, zoom, allowAggregation)) {
          continue
        }
        for (const agent of worktree.agents) {
          agents.set(agent.card.paneKey, { agent, worktreeId: worktree.id })
        }
      }
    }
    return agents
  }, [allowAggregation, layout, selectedPaneKey, zoom])
  return (
    <>
      {layout.projects.map((project) => {
        const worktreesById = new Map(project.worktrees.map((worktree) => [worktree.id, worktree]))
        const projectLabelHalfWidth = project.radius * mapScale
        const projectHostsById = new Map<string, AgentMapWorktreeRing>()
        for (const worktree of project.worktrees) {
          if (worktree.hostKind === 'ssh' || worktree.hostKind === 'remote') {
            projectHostsById.set(`${worktree.hostKind}:${worktree.executionHostId ?? ''}`, worktree)
          }
        }
        const projectHosts = [...projectHostsById.values()]
        const projectCountText = translate(
          'dashboardPopout.map.projectCount',
          '{{agents}} agents · {{workspaces}} workspaces',
          { agents: project.agentCount, workspaces: project.worktrees.length }
        ).toUpperCase()
        const crossWorktreeLineage = !showOrchestrationLinks
          ? []
          : project.worktrees.flatMap((worktree) =>
              worktree.agents.flatMap((child) => {
                const parent = child.card.parentPaneKey
                  ? visibleAgentsByPaneKey.get(child.card.parentPaneKey)
                  : undefined
                const childLocation = visibleAgentsByPaneKey.get(child.card.paneKey)
                return parent && childLocation && parent.worktreeId !== childLocation.worktreeId
                  ? [{ parent: parent.agent, child }]
                  : []
              })
            )
        return (
          <g
            key={project.id}
            className={`agent-map-project-node${project.motionState ? ` is-${project.motionState}` : ''}${heldProjectId === project.id ? ' is-held' : ''}`}
            data-agent-map-project-id={project.id}
            aria-hidden={project.motionState === 'exiting' || undefined}
          >
            <circle
              className="agent-map-project-ring"
              data-agent-map-project=""
              cx={project.x}
              cy={project.y}
              r={project.radius}
              onContextMenu={
                onOpenProjectContextMenu
                  ? (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onOpenProjectContextMenu(event, project)
                    }
                  : undefined
              }
            />
            <g className="agent-map-worktree-lineage-links" aria-hidden>
              {project.worktrees.map((child) => {
                const parent = child.parentId ? worktreesById.get(child.parentId) : undefined
                return !parent || child.y <= parent.y ? null : (
                  <path
                    key={child.id}
                    className={`agent-map-worktree-lineage-link${child.motionState === 'exiting' || parent.motionState === 'exiting' ? ' is-exiting' : child.motionState === 'entering' || parent.motionState === 'entering' ? ' is-entering' : ''}`}
                    data-agent-map-worktree-lineage-link=""
                    data-parent-worktree-id={parent.worktreeId}
                    data-child-worktree-id={child.worktreeId}
                    d={worktreeLineagePath(parent, child)}
                  />
                )
              })}
            </g>
            <g className="agent-map-lineage-links" aria-hidden>
              {crossWorktreeLineage.map(({ parent, child }) => (
                <path
                  key={child.card.paneKey}
                  className={`agent-map-lineage-link is-cross-worktree${parent.motionState === 'exiting' || child.motionState === 'exiting' ? ' is-exiting' : parent.motionState === 'entering' || child.motionState === 'entering' ? ' is-entering' : ''}`}
                  data-agent-map-lineage-link=""
                  data-agent-map-cross-worktree-lineage-link=""
                  data-agent-map-lineage-relation={AGENT_MAP_LINEAGE_RELATION}
                  data-parent-pane-key={parent.card.paneKey}
                  data-child-pane-key={child.card.paneKey}
                  d={agentLineagePath(parent, child)}
                />
              ))}
            </g>
            {project.worktrees.map((worktree) => (
              <AgentMapWorktreeRingNode
                key={worktree.id}
                project={project}
                worktree={worktree}
                zoom={zoom}
                mapScale={mapScale}
                held={heldWorktreeId === worktree.id}
                selectedPaneKey={selectedPaneKey}
                allowAggregation={allowAggregation}
                showOrchestrationLinks={showOrchestrationLinks}
                recentFlareStatuses={recentFlareStatuses}
                launchableAgents={launchableAgentsByWorktreeId?.[worktree.worktreeId]}
                nodeRefs={nodeRefs}
                onSelectAgent={onSelectAgent}
                onSpawnAgent={onSpawnAgent}
                onOpenWorkspaceContextMenu={onOpenWorkspaceContextMenu}
                onLabelHoverChange={handleLabelHoverChange}
                onLabelFocusChange={handleLabelFocusChange}
                onAgentKeyDown={onAgentKeyDown}
              />
            ))}
            <g className="agent-map-worktree-label-layer">
              {project.worktrees.map((worktree) =>
                worktree.id === activeWorktreeId ? null : (
                  <AgentMapWorktreeLabel
                    key={worktree.id}
                    worktree={worktree}
                    visible={visibleLabels.worktreeIds.has(worktree.id)}
                    active={false}
                    labelScale={labelScale}
                    mapScale={mapScale}
                  />
                )
              )}
            </g>
            <g
              transform={`translate(${project.x} ${project.y - project.radius}) scale(${labelScale})`}
            >
              <foreignObject
                className="agent-map-project-label-frame"
                x={-projectLabelHalfWidth}
                y={3}
                width={projectLabelHalfWidth * 2}
                height={18}
              >
                <div className="agent-map-project-label">
                  <RepoIconGlyph
                    repoIcon={repoIconsByRepoId?.[project.id] ?? null}
                    className="size-3 shrink-0"
                    iconClassName="size-3"
                  />
                  <span className="agent-map-project-name min-w-0 truncate">
                    {project.name.toUpperCase()}
                  </span>
                  {projectHosts.map((host) => (
                    <DashboardHostBadge
                      key={`${host.hostKind}:${host.executionHostId ?? ''}`}
                      hostKind={host.hostKind}
                      executionHostId={host.executionHostId}
                      hostLabel={host.hostLabel}
                      keyboardFocusable
                      className="agent-map-project-host-badge"
                    />
                  ))}
                </div>
              </foreignObject>
              {visibleLabels.projectCountIds.has(project.id) ? (
                <text className="agent-map-project-count" y={32}>
                  {projectCountText}
                </text>
              ) : null}
            </g>
          </g>
        )
      })}
      {/* Drawn last so a hovered name clears every other project's rings, and
       *  outside the declutter pass so it reads at any zoom. */}
      {activeWorktree ? (
        <g className="agent-map-worktree-hover-label-layer" data-agent-map-hover-label="">
          <AgentMapWorktreeLabel
            worktree={activeWorktree}
            visible={visibleLabels.worktreeIds.has(activeWorktree.id)}
            active
            labelScale={labelScale}
            mapScale={mapScale}
          />
        </g>
      ) : null}
    </>
  )
})
