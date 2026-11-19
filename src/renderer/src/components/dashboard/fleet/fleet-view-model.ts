import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardHostKind,
  DashboardCardWorkspaceKind
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { compareNumericLocaleText } from '../../../../../shared/i18n/locale-text-collators'
import { buildAgentRowLineageTree } from '../rows/agent-row-lineage-model'

export type FleetBucketCounts = Record<DashboardBucket, number>

export type FleetNode = {
  card: DashboardCard
  depth: number
  leafCount: number
  children: FleetNode[]
}

export type FleetTeam = {
  root: FleetNode
  size: number
  counts: FleetBucketCounts
  /** No member is working or waiting on the user. */
  settled: boolean
}

type FleetHost = Pick<DashboardCard, 'hostKind' | 'executionHostId'>

export type FleetProject = {
  key: string
  repoId: string
  repoName: string
  hostKind?: DashboardCardHostKind
  executionHostId?: ExecutionHostId
  hostLabel?: string
  workspaceKind: DashboardCardWorkspaceKind
  counts: FleetBucketCounts
  agents: number
  teams: FleetTeam[]
  solo: DashboardCard[]
}

export type FleetView = {
  summary: FleetBucketCounts & { agents: number; teams: number; projects: number }
  projects: FleetProject[]
}

type FleetLineageRow = {
  paneKey: string
  card: DashboardCard
  entry: { orchestration?: { parentPaneKey: string } }
}

export function fleetHostKey(host: FleetHost): string {
  return host.executionHostId ?? host.hostKind ?? 'local'
}

export function fleetProjectKey(card: FleetHost & Pick<DashboardCard, 'repoId'>): string {
  return JSON.stringify([fleetHostKey(card), card.repoId])
}

function emptyCounts(): FleetBucketCounts {
  return { attention: 0, working: 0, done: 0, idle: 0 }
}

function lastActivity(card: DashboardCard): number {
  return Math.max(card.stateChangedAt, card.startedAt, card.finishedAt ?? 0)
}

function collectCards(node: FleetNode, into: DashboardCard[]): DashboardCard[] {
  into.push(node.card)
  for (const child of node.children) {
    collectCards(child, into)
  }
  return into
}

function countBuckets(cards: readonly DashboardCard[]): FleetBucketCounts {
  const counts = emptyCounts()
  for (const card of cards) {
    counts[card.bucket] += 1
  }
  return counts
}

type RankedTeam = { team: FleetTeam; activity: number }

type ProjectGroup = {
  anchor: DashboardCard
  teams: RankedTeam[]
  solo: DashboardCard[]
  cards: DashboardCard[]
}

function toProject(key: string, group: ProjectGroup): FleetProject {
  const { anchor } = group
  return {
    key,
    repoId: anchor.repoId,
    repoName: anchor.repoName,
    hostKind: anchor.hostKind,
    executionHostId: anchor.executionHostId,
    hostLabel: anchor.hostLabel,
    workspaceKind: anchor.workspaceKind ?? 'worktree',
    counts: countBuckets(group.cards),
    agents: group.cards.length,
    teams: group.teams.sort((a, b) => b.activity - a.activity).map(({ team }) => team),
    solo: group.solo.sort((a, b) => lastActivity(b) - lastActivity(a))
  }
}

function compareProjects(a: FleetProject, b: FleetProject): number {
  return (
    compareNumericLocaleText(a.repoName, b.repoName) ||
    compareNumericLocaleText(a.hostLabel ?? '', b.hostLabel ?? '') ||
    compareNumericLocaleText(a.key, b.key)
  )
}

export function buildFleetView(cards: readonly DashboardCard[]): FleetView {
  const rows: FleetLineageRow[] = cards.map((card) => ({
    paneKey: card.paneKey,
    card,
    entry: card.parentPaneKey ? { orchestration: { parentPaneKey: card.parentPaneKey } } : {}
  }))
  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)

  const toNode = (row: FleetLineageRow, depth: number): FleetNode => {
    const children = (childrenByParentPaneKey.get(row.paneKey) ?? []).map((child) =>
      toNode(child, depth + 1)
    )
    const leafCount =
      children.length === 0 ? 1 : children.reduce((total, child) => total + child.leafCount, 0)
    return { card: row.card, depth, leafCount, children }
  }

  const groups = new Map<string, ProjectGroup>()
  for (const row of rootRows) {
    const key = fleetProjectKey(row.card)
    let group = groups.get(key)
    if (!group) {
      group = { anchor: row.card, teams: [], solo: [], cards: [] }
      groups.set(key, group)
    }
    const root = toNode(row, 0)
    if (root.children.length === 0) {
      group.solo.push(row.card)
      group.cards.push(row.card)
      continue
    }
    const members = collectCards(root, [])
    group.cards.push(...members)
    const counts = countBuckets(members)
    group.teams.push({
      team: {
        root,
        size: members.length,
        counts,
        settled: counts.working === 0 && counts.attention === 0
      },
      activity: Math.max(...members.map(lastActivity))
    })
  }

  const projects = [...groups].map(([key, group]) => toProject(key, group)).sort(compareProjects)
  const teams = projects.reduce((total, project) => total + project.teams.length, 0)
  return {
    summary: { ...countBuckets(cards), agents: cards.length, teams, projects: projects.length },
    projects
  }
}
