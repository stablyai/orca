import { KeyedChangeJournal } from '../../../../../shared/collections/keyed-change-journal'
import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

type CardOwner = { journal: KeyedChangeJournal; indexes?: Map<string, number> }
const revisions = new WeakMap<DashboardCard[], { owner: CardOwner; cursor: number }>()

function revision(cards: DashboardCard[]) {
  let current = revisions.get(cards)
  if (!current) {
    current = { owner: { journal: new KeyedChangeJournal() }, cursor: 0 }
    revisions.set(cards, current)
  }
  return current
}

/** Replace cards at stable positions, keeping a bounded journal for readers that skip a render. */
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
  const { owner } = revision(cards)
  if (!owner.indexes) {
    owner.indexes = new Map()
    cards.forEach((card, index) => {
      if (!owner.indexes!.has(card.paneKey)) {
        owner.indexes!.set(card.paneKey, index)
      }
    })
  }
  return owner.indexes.get(paneKey) ?? -1
}
