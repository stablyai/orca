import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { formatNativeChatDuration } from '../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import { fleetCardEnd } from './fleet-view-model'

export function fleetCardTitle(card: DashboardCard): string {
  return card.conversationName ?? (card.task || card.worktreeName)
}

export function fleetElapsed(startedAt: number, end: number): string {
  return formatNativeChatDuration((end - startedAt) / 1000)
}

export function fleetCardElapsed(card: DashboardCard, now: number): string {
  return fleetElapsed(card.startedAt, fleetCardEnd(card, now))
}
