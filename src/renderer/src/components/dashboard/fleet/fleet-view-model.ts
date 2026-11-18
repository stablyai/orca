import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { buildAgentRowLineageTree } from '../rows/agent-row-lineage-model'

export type FleetBucketCounts = Record<DashboardBucket, number>

export type FleetNode = { card: DashboardCard; depth: number; children: FleetNode[] }

export type FleetTeam = {
  root: FleetNode
  size: number
  counts: FleetBucketCounts
  startedAt: number
  endedAt: number | null
}

export type FleetView = {
  summary: FleetBucketCounts & { agents: number; teams: number }
  teams: FleetTeam[]
  solo: DashboardCard[]
  window: { from: number; to: number }
}

type FleetLineageRow = {
  paneKey: string
  card: DashboardCard
  entry: { orchestration?: { parentPaneKey: string } }
}

function emptyCounts(): FleetBucketCounts {
  return { attention: 0, working: 0, done: 0, idle: 0 }
}

function isLive(card: DashboardCard): boolean {
  return card.bucket === 'working' || card.bucket === 'attention'
}

/** finishedAt keeps the last completion, so a live card that finished an earlier turn still ends at now. */
export function fleetCardEnd(card: DashboardCard, now: number): number {
  return isLive(card) ? now : (card.finishedAt ?? now)
}

function lastActivity(card: DashboardCard): number {
  return Math.max(card.stateChangedAt, card.startedAt, card.finishedAt ?? 0)
}

function collectNodes(node: FleetNode, into: DashboardCard[]): DashboardCard[] {
  into.push(node.card)
  for (const child of node.children) {
    collectNodes(child, into)
  }
  return into
}

function buildTeam(root: FleetNode): FleetTeam {
  const members = collectNodes(root, [])
  const counts = emptyCounts()
  let startedAt = Number.POSITIVE_INFINITY
  let endedAt: number | null = 0
  for (const card of members) {
    counts[card.bucket] += 1
    startedAt = Math.min(startedAt, card.startedAt)
    endedAt =
      endedAt === null || isLive(card) || card.finishedAt === null
        ? null
        : Math.max(endedAt, card.finishedAt)
  }
  return { root, size: members.length, counts, startedAt, endedAt }
}

export function buildFleetView(cards: readonly DashboardCard[], now: number): FleetView {
  const rows: FleetLineageRow[] = cards.map((card) => ({
    paneKey: card.paneKey,
    card,
    entry: card.parentPaneKey ? { orchestration: { parentPaneKey: card.parentPaneKey } } : {}
  }))
  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)

  const toNode = (row: FleetLineageRow, depth: number): FleetNode => ({
    card: row.card,
    depth,
    children: (childrenByParentPaneKey.get(row.paneKey) ?? []).map((child) =>
      toNode(child, depth + 1)
    )
  })

  const ranked: { team: FleetTeam; activity: number }[] = []
  const solo: DashboardCard[] = []
  for (const row of rootRows) {
    const root = toNode(row, 0)
    if (root.children.length === 0) {
      solo.push(row.card)
      continue
    }
    const activity = Math.max(...collectNodes(root, []).map(lastActivity))
    ranked.push({ team: buildTeam(root), activity })
  }
  ranked.sort((a, b) => b.activity - a.activity)
  const teams = ranked.map(({ team }) => team)
  solo.sort((a, b) => lastActivity(b) - lastActivity(a))

  const summary = { ...emptyCounts(), agents: cards.length, teams: teams.length }
  let from = now
  for (const card of cards) {
    summary[card.bucket] += 1
    if (card.startedAt > 0) {
      from = Math.min(from, card.startedAt)
    }
  }

  return { summary, teams, solo, window: { from, to: now } }
}
