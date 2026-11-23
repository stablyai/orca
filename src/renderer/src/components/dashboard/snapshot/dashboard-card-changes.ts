import { KeyedChangeJournal } from '../../../../../shared/collections/keyed-change-journal'
import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

type CardOwner = {
  journal: KeyedChangeJournal
  paneIndex?: { positions: Map<string, number>; searched: number }
}
const revisions = new WeakMap<DashboardCard[], { owner: CardOwner; cursor: number }>()

function revision(cards: DashboardCard[]) {
  let current = revisions.get(cards)
  if (!current) {
    current = { owner: { journal: new KeyedChangeJournal() }, cursor: 0 }
    revisions.set(cards, current)
  }
  return current
}

/** Replace card content at stable pane positions, keeping a bounded journal for readers that skip a render. */
export function replaceDashboardCards(
  cards: DashboardCard[],
  changes: ReadonlyMap<number, DashboardCard>
): DashboardCard[] {
  if (!changes.size) {
    return cards
  }
  const next = cards.slice()
  const previous = revision(cards)
  const { journal } = previous.owner
  const keys = new Set<string>()
  for (const [index, card] of changes) {
    next[index] = card
    keys.add(String(index))
  }
  if (previous.cursor === journal.cursor()) {
    journal.publish(keys)
    revisions.set(next, { owner: previous.owner, cursor: journal.cursor() })
  }
  return next
}

export function dashboardCardChangesSince(
  cards: DashboardCard[],
  previous: DashboardCard[]
): number[] | null {
  if (cards === previous) {
    return []
  }
  const next = revisions.get(cards)
  const prior = revisions.get(previous)
  if (
    !next ||
    !prior ||
    next.owner !== prior.owner ||
    next.cursor !== next.owner.journal.cursor()
  ) {
    return null
  }
  const changes = next.owner.journal.since(prior.cursor)
  return changes ? Array.from(changes, Number) : null
}

export function dashboardCardIndex(cards: DashboardCard[], paneKey: string): number {
  const current = revisions.get(cards)
  if (!current) {
    return cards.findIndex((card) => card.paneKey === paneKey)
  }
  const paneIndex = (current.owner.paneIndex ??= { positions: new Map(), searched: 0 })
  const known = paneIndex.positions.get(paneKey)
  if (known !== undefined) {
    return known
  }
  while (paneIndex.searched < cards.length) {
    const index = paneIndex.searched
    const key = cards[index].paneKey
    paneIndex.searched++
    if (!paneIndex.positions.has(key)) {
      paneIndex.positions.set(key, index)
    }
    if (key === paneKey) {
      return index
    }
  }
  return -1
}
