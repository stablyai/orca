// Node status → design token. Colors come from the shared tokens in main.css; the SVG
// fills/strokes read them as CSS vars so the map follows the active theme.

import type { AgentMapNodeStatus } from '../../../../shared/agent-session-map/agent-session-map-model'
import { translate } from '@/i18n/i18n'

export type AgentMapStatusColor = {
  /** Node ring / edge accent. */
  stroke: string
  /** Node fill. */
  fill: string
}

export const AGENT_MAP_STATUS_COLORS: Record<AgentMapNodeStatus, AgentMapStatusColor> = {
  running: {
    stroke: 'var(--color-primary)',
    fill: 'color-mix(in srgb, var(--color-primary) 14%, transparent)'
  },
  waiting: {
    stroke: 'var(--color-status-warning)',
    fill: 'var(--color-status-warning-background)'
  },
  done: {
    stroke: 'var(--color-status-success)',
    fill: 'var(--color-status-success-background)'
  },
  idle: {
    stroke: 'var(--color-muted-foreground)',
    fill: 'var(--color-muted)'
  },
  failed: {
    stroke: 'var(--color-destructive)',
    fill: 'color-mix(in srgb, var(--color-destructive) 12%, transparent)'
  },
  unknown: {
    stroke: 'var(--color-muted-foreground)',
    fill: 'var(--color-muted)'
  }
}

/** A short human label for a status, for the node subtitle and tooltips. */
export function agentMapStatusLabel(status: AgentMapNodeStatus): string {
  switch (status) {
    case 'running':
      return translate('components.agentSessionMap.status.running', 'Running')
    case 'waiting':
      return translate('components.agentSessionMap.status.waiting', 'Waiting')
    case 'done':
      return translate('components.agentSessionMap.status.done', 'Done')
    case 'idle':
      return translate('components.agentSessionMap.status.idle', 'Idle')
    case 'failed':
      return translate('components.agentSessionMap.status.failed', 'Failed')
    case 'unknown':
      return translate('components.agentSessionMap.status.unknown', 'Unknown')
  }
}
