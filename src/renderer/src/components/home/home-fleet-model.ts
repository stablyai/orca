import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

export type HomeFleet = {
  needsYou: DashboardCard[]
  runningNow: DashboardCard[]
  recentlyFinished: DashboardCard[]
  counts: { attention: number; working: number; done: number }
}

// Zero means the bucket-entry time is unknown, so those rows sort after timed ones.
function waitingSince(card: DashboardCard): number {
  return card.stateChangedAt > 0 ? card.stateChangedAt : Number.POSITIVE_INFINITY
}

function finishedAt(card: DashboardCard): number {
  return card.finishedAt ?? card.stateChangedAt
}

export function buildHomeFleet(cards: readonly DashboardCard[]): HomeFleet {
  const needsYou = cards
    .filter((card) => card.bucket === 'attention')
    .sort((a, b) => waitingSince(a) - waitingSince(b))
  const runningNow = cards
    .filter((card) => card.bucket === 'working')
    .sort((a, b) => a.startedAt - b.startedAt)
  const recentlyFinished = cards
    .filter((card) => card.bucket === 'done')
    .sort((a, b) => finishedAt(b) - finishedAt(a))
  return {
    needsYou,
    runningNow,
    recentlyFinished,
    counts: {
      attention: needsYou.length,
      working: runningNow.length,
      done: recentlyFinished.length
    }
  }
}

export function homeAgentTitle(card: DashboardCard): string {
  return card.conversationName || card.task || card.agentType
}
