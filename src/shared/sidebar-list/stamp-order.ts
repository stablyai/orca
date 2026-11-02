import { isSmartTier, type SmartTier } from './sort-stamps'

/** The sort stamps a row carries, as its owning host wrote them. */
export type StampOrderRow = {
  lastActivityAt?: number
  smartTier?: SmartTier
  smartAt?: number
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

// A tier a newer host knows and this client does not reads as Rest.
function tierRank(row: StampOrderRow): number {
  return isSmartTier(row.smartTier) ? TIER_RANK[row.smartTier] : REST_RANK
}

/** Smart by stamps: Needs you, Done, Working, each newest first; then Rest by Recent. */
export function compareSmartStamps(a: StampOrderRow, b: StampOrderRow): number {
  const rankA = tierRank(a)
  const rankB = tierRank(b)
  return (
    rankA - rankB ||
    (rankA < REST_RANK ? finiteOr0(b.smartAt) - finiteOr0(a.smartAt) : 0) ||
    recentStamp(b) - recentStamp(a)
  )
}
