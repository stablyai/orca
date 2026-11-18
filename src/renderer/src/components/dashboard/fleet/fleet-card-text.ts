import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { formatNativeChatDuration } from '../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import { fleetCardEnd } from './fleet-view-model'

export function fleetCardTitle(card: DashboardCard): string {
  return card.conversationName ?? (card.task || card.worktreeName)
}

/** A zero start means the producer has no start time, so there is nothing to measure. */
export function fleetElapsed(startedAt: number, end: number): string | null {
  return startedAt > 0 ? formatNativeChatDuration((end - startedAt) / 1000) : null
}

export function fleetCardElapsed(card: DashboardCard, now: number): string | null {
  return fleetElapsed(card.startedAt, fleetCardEnd(card, now))
}
