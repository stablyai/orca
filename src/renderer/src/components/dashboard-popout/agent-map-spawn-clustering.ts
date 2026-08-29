import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function selectAgentMapSpawnParentContainer(
  cards: readonly DashboardCard[],
  cardsByPaneKey: ReadonlyMap<string, DashboardCard>,
  containerIdentity: (card: DashboardCard) => string
): string | undefined {
  const ownContainerId = cards[0] ? containerIdentity(cards[0]) : undefined
  const linkCounts = new Map<string, number>()
  for (const card of cards) {
    const parent = card.parentPaneKey ? cardsByPaneKey.get(card.parentPaneKey) : undefined
    const parentContainerId = parent ? containerIdentity(parent) : undefined
    if (!parentContainerId || parentContainerId === ownContainerId) {
      continue
    }
    linkCounts.set(parentContainerId, (linkCounts.get(parentContainerId) ?? 0) + 1)
  }
  return [...linkCounts]
    .sort(([leftId, leftCount], [rightId, rightCount]) =>
      rightCount !== leftCount ? rightCount - leftCount : compareStable(leftId, rightId)
    )
    .at(0)?.[0]
}
