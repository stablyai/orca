import { isSmartTier, type SmartTier } from './sort-stamps'

/** The sort stamps a row carries, as its owning host wrote them. */
export type StampOrderRow = {
  lastActivityAt?: number
  smartTier?: SmartTier
  smartAt?: number
  /** The workspace unread flag: an agent finished while you were not looking. */
  isUnread?: boolean
}

const TIER_RANK: Record<SmartTier, number> = { 'needs-you': 0, done: 1, working: 2 }
const REST_RANK = 3

function finiteOr0(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

/** Recent by the host's stamp alone: no clock, no create grace. */
export function recentStamp(row: StampOrderRow): number {
  return finiteOr0(row.lastActivityAt)
}

/** Direct Smi (-1 | 0 | 1) descending comparison of host recency stamps without HeapNumber return boxing. */
export function compareRecentStamps(a: StampOrderRow, b: StampOrderRow): number {
  const rawA = a.lastActivityAt
  const rawB = b.lastActivityAt
  const recA = rawA !== undefined && Number.isFinite(rawA) ? rawA : 0
  const recB = rawB !== undefined && Number.isFinite(rawB) ? rawB : 0
  return recA > recB ? -1 : recA < recB ? 1 : 0
}

// Unknown tiers read Rest. Done ranks only while unread; newer hosts retier seen Done beside Working,
// while older hosts leave it Done and therefore Rest to this reader.
function tierRank(row: StampOrderRow): number {
  if (!isSmartTier(row.smartTier) || (row.smartTier === 'done' && row.isUnread !== true)) {
    return REST_RANK
  }
  return TIER_RANK[row.smartTier]
}

/** Smart by stamps: Needs you, unread Done, Working, each newest first; then Rest by Recent. */
export function compareSmartStamps(a: StampOrderRow, b: StampOrderRow): number {
  const rankA = tierRank(a)
  const rankB = tierRank(b)
  if (rankA !== rankB) {
    return rankA - rankB
  }
  if (rankA < REST_RANK) {
    const smartA = finiteOr0(a.smartAt)
    const smartB = finiteOr0(b.smartAt)
    if (smartA !== smartB) {
      return smartA > smartB ? -1 : 1
    }
  }
  const recA = recentStamp(a)
  const recB = recentStamp(b)
  return recA > recB ? -1 : recA < recB ? 1 : 0
}
