import { memo, useCallback, useMemo, useState, type MutableRefObject } from 'react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { translate } from '@/i18n/i18n'
import type { DashboardCard, DashboardSpawnAgentArgs } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import type { TuiAgent } from '../../../../shared/types'
import type {
  AgentMapAgentNode,
  AgentMapLayout,
  AgentMapProjectRing,
  AgentMapWorktreeRing
} from './agent-map-layout'
import { AGENT_MAP_LINEAGE_RELATION, shouldAggregateAgentMapWorktree } from './agent-map-layout'
import { selectVisibleAgentMapLabels } from './agent-map-label-declutter'
import { AgentMapWorktreeLabel } from './AgentMapWorktreeLabel'
import { AgentMapWorktreeRingNode } from './AgentMapWorktreeRingNode'

type AgentMapSceneProps = {
  layout: AgentMapLayout
  repoIconsByRepoId?: Record<string, RepoIcon | null>
  zoom: number
  labelScale: number
  mapScale: number
  selectedPaneKey: string | null
  allowAggregation: boolean
  showOrchestrationLinks: boolean
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
  const dx = child.x - parent.x
  const dy = child.y - parent.y
  const distance = Math.hypot(dx, dy)
  if (distance === 0) {
    return `M ${parent.x} ${parent.y}`
  }
  const unitX = dx / distance
  const unitY = dy / distance
  return `M ${parent.x + unitX * parent.radius} ${parent.y + unitY * parent.radius} L ${child.x - unitX * child.radius} ${child.y - unitY * child.radius}`
}

/** Memoization keeps pointer panning to one SVG viewBox write, not a map rerender. */
export const AgentMapScene = memo(function AgentMapScene({
  layout,
  repoIconsByRepoId,
  zoom,
  labelScale,
  mapScale,
  selectedPaneKey,
  allowAggregation,
  showOrchestrationLinks,
  launchableAgentsByWorktreeId,
  nodeRefs,
  onSelectAgent,
  onSpawnAgent,
  onOpenProjectContextMenu,
  onOpenWorkspaceContextMenu,
  onAgentKeyDown
}: AgentMapSceneProps): React.JSX.Element {
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null)
  const handleLabelActiveChange = useCallback((worktreeId: string, active: boolean): void => {
    setActiveWorktreeId((current) =>
      active ? worktreeId : current === worktreeId ? null : current
    )
  }, [])
  const visibleLabels = useMemo(
    () => selectVisibleAgentMapLabels(layout, labelScale, mapScale),
    [labelScale, layout, mapScale]
  )
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
          <g key={project.id}>
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
                    className="agent-map-worktree-lineage-link"
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
                  className="agent-map-lineage-link is-cross-worktree"
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
                selectedPaneKey={selectedPaneKey}
                allowAggregation={allowAggregation}
                showOrchestrationLinks={showOrchestrationLinks}
                launchableAgents={launchableAgentsByWorktreeId?.[worktree.worktreeId]}
                nodeRefs={nodeRefs}
                onSelectAgent={onSelectAgent}
                onSpawnAgent={onSpawnAgent}
                onOpenWorkspaceContextMenu={onOpenWorkspaceContextMenu}
                onLabelActiveChange={handleLabelActiveChange}
                onAgentKeyDown={onAgentKeyDown}
              />
            ))}
            <g className="agent-map-worktree-label-layer">
              {project.worktrees.map((worktree) => (
                <AgentMapWorktreeLabel
                  key={worktree.id}
                  worktree={worktree}
                  visible={visibleLabels.worktreeIds.has(worktree.id)}
                  active={
                    activeWorktreeId === worktree.id &&
                    visibleLabels.worktreeAgentSafeIds.has(worktree.id)
                  }
                  labelScale={labelScale}
                  mapScale={mapScale}
                />
              ))}
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
    </>
  )
})
