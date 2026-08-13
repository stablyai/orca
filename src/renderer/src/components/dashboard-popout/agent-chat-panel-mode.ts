import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

export type AgentChatPanelMode =
  | { kind: 'live'; sessionId: string; transcriptPath: string | null }
  | { kind: 'degraded'; reason: 'no-session' | 'remote-host' }

/** Remote transcript paths are not readable by the local dashboard renderer. */
export function resolveAgentChatPanelMode(card: DashboardCard): AgentChatPanelMode {
  if (card.hostKind === 'ssh' || card.hostKind === 'wsl' || card.hostKind === 'remote') {
    return { kind: 'degraded', reason: 'remote-host' }
  }
  if (!card.sessionId) {
    return { kind: 'degraded', reason: 'no-session' }
  }
  return { kind: 'live', sessionId: card.sessionId, transcriptPath: card.transcriptPath ?? null }
}
