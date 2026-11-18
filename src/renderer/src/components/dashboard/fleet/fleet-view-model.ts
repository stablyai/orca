import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { buildAgentRowLineageTree } from '../rows/agent-row-lineage-model'

export type FleetBucketCounts = Record<DashboardBucket, number>

export type FleetNode = {
  card: DashboardCard
  depth: number
  leafCount: number
  children: FleetNode[]
}

export type FleetTeam = { root: FleetNode; size: number; counts: FleetBucketCounts }

export type FleetView = {
  summary: FleetBucketCounts & { agents: number; teams: number }
  teams: FleetTeam[]
  solo: DashboardCard[]
}

type FleetLineageRow = {
  paneKey: string
  card: DashboardCard
  entry: { orchestration?: { parentPaneKey: string } }
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

  const ranked: { team: FleetTeam; activity: number }[] = []
  const solo: DashboardCard[] = []
  for (const row of rootRows) {
    const root = toNode(row, 0)
    if (root.children.length === 0) {
      solo.push(row.card)
      continue
    }
    const members = collectCards(root, [])
    const counts = emptyCounts()
    for (const card of members) {
      counts[card.bucket] += 1
    }
    ranked.push({
      team: { root, size: members.length, counts },
      activity: Math.max(...members.map(lastActivity))
    })
  }
  ranked.sort((a, b) => b.activity - a.activity)
  solo.sort((a, b) => lastActivity(b) - lastActivity(a))

  const summary = { ...emptyCounts(), agents: cards.length, teams: ranked.length }
  for (const card of cards) {
    summary[card.bucket] += 1
  }
  return { summary, teams: ranked.map(({ team }) => team), solo }
}
