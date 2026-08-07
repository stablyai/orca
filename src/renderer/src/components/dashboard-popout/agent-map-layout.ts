import type * as DashboardSnapshotTypes from '../../../../shared/dashboard-snapshot'
import { placeAgentMapAgents } from './agent-map-agent-placement'
import { layoutAgentMapLineage } from './agent-map-lineage-layout'
import { refreshAgentMapMetadata } from './agent-map-layout-metadata'
import { agentMapDurationMinutes, agentMapNodeStatus } from './agent-map-node-metadata'
import { placeAgentMapProjects } from './agent-map-project-placement'
import { selectAgentMapSpawnParentContainer } from './agent-map-spawn-clustering'
import {
  agentMapCardTopologyIdentity,
  agentMapWorkspaceIdentity,
  agentMapWorkspaceTopologyIdentity,
  agentMapWorktreeIdentity,
  agentMapWorktreeIdentityFromParts
} from './agent-map-workspace-identity'
import { layoutAgentMapWorktreeLineage } from './agent-map-worktree-lineage-layout'

type DashboardCard = DashboardSnapshotTypes.DashboardCard
type DashboardCardDotState = DashboardSnapshotTypes.DashboardCardDotState
type DashboardWorkspace = DashboardSnapshotTypes.DashboardWorkspace

export { AGENT_MAP_WORKTREE_GAP } from './agent-map-worktree-packing'
export { agentMapDurationMinutes, agentMapNodeStatus } from './agent-map-node-metadata'

export const AGENT_MAP_AGENT_RADIUS = 20
export const AGENT_MAP_AGGREGATE_ZOOM = 1.15
export const AGENT_MAP_RING_HEADER_HEIGHT = 40

const PROJECT_PADDING = 12
const WORLD_MARGIN = 32
const RING_CONTENT_OFFSET = AGENT_MAP_RING_HEADER_HEIGHT / 2

export type AgentMapStatusCounts = Record<DashboardCardDotState, number>

export type AgentMapAgentNode = {
  card: DashboardCard
  x: number
  y: number
  radius: number
  durationMinutes: number
  status: DashboardCardDotState
}

export type AgentMapWorktreeRing = {
  id: string
  parentId?: string
  /** Layout-only parent chosen from agent spawn edges; does not imply workspace lineage. */
  clusterParentId?: string
  worktreeId: string
  executionHostId: DashboardCard['executionHostId']
  name: string
  workspaceKind: NonNullable<DashboardCard['workspaceKind']>
  x: number
  y: number
  radius: number
  agents: AgentMapAgentNode[]
  statusCounts: AgentMapStatusCounts
  quiet: boolean
}

export type AgentMapProjectRing = {
  id: string
  name: string
  x: number
  y: number
  radius: number
  worktrees: AgentMapWorktreeRing[]
  agentCount: number
}

export type AgentMapLayout = {
  projects: AgentMapProjectRing[]
  width: number
  height: number
  topologyKey: string
}

export type AgentMapLayoutCache = {
  topologyKey: string
  geometry: AgentMapLayout
  packingGeneration: number
}

type LocalWorktree = Omit<AgentMapWorktreeRing, 'x' | 'y'> & { x: number; y: number }
type LocalProject = Omit<AgentMapProjectRing, 'x' | 'y' | 'worktrees'> & {
  x: number
  y: number
  clusterParentId?: string
  worktrees: LocalWorktree[]
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function agentMapTopologyKey(
  cards: DashboardCard[],
  workspaces: DashboardWorkspace[] = []
): string {
  return [
    ...cards.map((card) => `a:${agentMapCardTopologyIdentity(card)}`),
    ...workspaces.map((workspace) => `w:${agentMapWorkspaceTopologyIdentity(workspace)}`)
  ]
    .sort(compareStable)
    .join('|')
}

export function shouldAggregateAgentMapWorktree(
  worktree: AgentMapWorktreeRing,
  zoom: number,
  allowAggregation = true
): boolean {
  return (
    allowAggregation &&
    zoom < AGENT_MAP_AGGREGATE_ZOOM &&
    worktree.quiet &&
    worktree.agents.length > 3
  )
}

function emptyStatusCounts(): AgentMapStatusCounts {
  return { working: 0, blocked: 0, waiting: 0, done: 0, idle: 0 }
}

function worktreeRadius(agentCount: number): number {
  return Math.max(
    52,
    24 + Math.ceil(Math.sqrt(Math.max(1, agentCount))) * (AGENT_MAP_AGENT_RADIUS + 8)
  )
}

function buildLocalWorktree(
  id: string,
  cards: DashboardCard[],
  now: number,
  workspace?: DashboardWorkspace
): LocalWorktree {
  const lineageLayout = layoutAgentMapLineage(cards, AGENT_MAP_AGENT_RADIUS)
  const contentRadius = lineageLayout?.radius ?? worktreeRadius(cards.length)
  const radius = contentRadius + RING_CONTENT_OFFSET
  const statusCounts = emptyStatusCounts()
  for (const card of cards) {
    statusCounts[agentMapNodeStatus(card)] += 1
  }
  const executionHostId = workspace?.executionHostId ?? cards[0]?.executionHostId
  const parentWorktreeId = workspace?.parentWorktreeId ?? cards[0]?.parentWorktreeId
  return {
    id,
    parentId: parentWorktreeId
      ? agentMapWorktreeIdentityFromParts(parentWorktreeId, executionHostId)
      : undefined,
    worktreeId: workspace?.worktreeId ?? cards[0]?.worktreeId ?? id,
    executionHostId,
    name: workspace?.worktreeName ?? cards[0]?.worktreeName ?? id,
    workspaceKind: workspace?.workspaceKind ?? cards[0]?.workspaceKind ?? 'worktree',
    x: 0,
    y: 0,
    radius,
    agents: (
      lineageLayout?.agents.map(({ card, x, y }) => ({
        card,
        x,
        y,
        radius: AGENT_MAP_AGENT_RADIUS,
        durationMinutes: agentMapDurationMinutes(card, now),
        status: agentMapNodeStatus(card)
      })) ??
      placeAgentMapAgents({
        worktreeId: id,
        cards,
        radius: contentRadius,
        agentRadius: AGENT_MAP_AGENT_RADIUS,
        now
      })
    ).map((agent) => ({ ...agent, y: agent.y + RING_CONTENT_OFFSET })),
    statusCounts,
    quiet: statusCounts.idle === cards.length
  }
}

function buildLocalProject(
  id: string,
  cards: DashboardCard[],
  workspaces: DashboardWorkspace[],
  cardsByPaneKey: ReadonlyMap<string, DashboardCard>,
  now: number
): LocalProject {
  const byWorktree = new Map<string, DashboardCard[]>()
  for (const card of cards) {
    const identity = agentMapWorktreeIdentity(card)
    const current = byWorktree.get(identity)
    if (current) {
      current.push(card)
    } else {
      byWorktree.set(identity, [card])
    }
  }
  const workspacesById = new Map(
    workspaces.map((workspace) => [agentMapWorkspaceIdentity(workspace), workspace])
  )
  for (const workspaceId of workspacesById.keys()) {
    if (!byWorktree.has(workspaceId)) {
      byWorktree.set(workspaceId, [])
    }
  }
  const positionedWorktrees = layoutAgentMapWorktreeLineage(
    [...byWorktree.entries()]
      .sort(([a], [b]) => compareStable(a, b))
      .map(([worktreeId, worktreeCards]) => ({
        ...buildLocalWorktree(worktreeId, worktreeCards, now, workspacesById.get(worktreeId)),
        clusterParentId: selectAgentMapSpawnParentContainer(
          worktreeCards,
          cardsByPaneKey,
          agentMapWorktreeIdentity
        )
      }))
  )
  const contentRadius = Math.max(
    84,
    ...positionedWorktrees.map(
      (worktree) => Math.hypot(worktree.x, worktree.y) + worktree.radius + PROJECT_PADDING
    )
  )
  const worktrees = positionedWorktrees.map((worktree) => ({
    ...worktree,
    y: worktree.y + RING_CONTENT_OFFSET
  }))
  return {
    id,
    name: cards[0]?.repoName ?? workspaces[0]?.repoName ?? id,
    x: 0,
    y: 0,
    clusterParentId: selectAgentMapSpawnParentContainer(
      cards,
      cardsByPaneKey,
      (card) => card.repoId
    ),
    radius: contentRadius + RING_CONTENT_OFFSET,
    worktrees,
    agentCount: cards.length
  }
}

export function deriveAgentMapLayout(
  cards: DashboardCard[],
  now: number,
  workspaces: DashboardWorkspace[] = []
): AgentMapLayout {
  const topologyKey = agentMapTopologyKey(cards, workspaces)
  if (cards.length === 0 && workspaces.length === 0) {
    return { projects: [], width: 900, height: 560, topologyKey }
  }
  const byProject = new Map<string, { cards: DashboardCard[]; workspaces: DashboardWorkspace[] }>()
  for (const card of cards) {
    const current = byProject.get(card.repoId) ?? { cards: [], workspaces: [] }
    current.cards.push(card)
    byProject.set(card.repoId, current)
  }
  for (const workspace of workspaces) {
    const current = byProject.get(workspace.repoId) ?? { cards: [], workspaces: [] }
    current.workspaces.push(workspace)
    byProject.set(workspace.repoId, current)
  }
  const cardsByPaneKey = new Map(cards.map((card) => [card.paneKey, card]))
  const localProjects = [...byProject.entries()]
    .sort(([a], [b]) => compareStable(a, b))
    .map(([projectId, project]) =>
      buildLocalProject(projectId, project.cards, project.workspaces, cardsByPaneKey, now)
    )
  const framed = placeAgentMapProjects(localProjects, 900, 560, WORLD_MARGIN)
  const projects = framed.projects.map((project): AgentMapProjectRing => {
    return {
      ...project,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        x: project.x + worktree.x,
        y: project.y + worktree.y,
        agents: worktree.agents.map((agent) => ({
          ...agent,
          x: project.x + worktree.x + agent.x,
          y: project.y + worktree.y + agent.y
        }))
      }))
    }
  })
  return { projects, width: framed.width, height: framed.height, topologyKey }
}

export function updateAgentMapLayout(
  cache: AgentMapLayoutCache | null,
  cards: DashboardCard[],
  now: number,
  workspaces: DashboardWorkspace[] = []
): { cache: AgentMapLayoutCache; layout: AgentMapLayout } {
  const topologyKey = agentMapTopologyKey(cards, workspaces)
  if (!cache || cache.topologyKey !== topologyKey) {
    const geometry = deriveAgentMapLayout(cards, now, workspaces)
    return {
      cache: {
        topologyKey,
        geometry,
        packingGeneration: (cache?.packingGeneration ?? 0) + 1
      },
      layout: geometry
    }
  }
  const layout = refreshAgentMapMetadata(cache.geometry, cards, now)
  return { cache, layout }
}
