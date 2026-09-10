import type { AgentStatusEntry } from './agent-status-types'
import {
  AGENT_NOTIFICATION_MODES,
  type AgentNotificationIntent,
  type AgentNotificationMode
} from './notification-settings-types'
import type { OrchestrationFleetAttentionCategory } from './orchestration-fleet-attention'

const FAILURE_CATEGORIES = new Set<OrchestrationFleetAttentionCategory>([
  'failure',
  'interruption',
  'unverifiable'
])
const ACTION_CATEGORIES = new Set<OrchestrationFleetAttentionCategory>([
  'input',
  'approval',
  'guidance'
])

export function isAgentNotificationMode(value: unknown): value is AgentNotificationMode {
  return AGENT_NOTIFICATION_MODES.some((mode) => mode === value)
}

export function shouldSurfaceAgentNotification(
  mode: AgentNotificationMode | undefined,
  intent: AgentNotificationIntent | undefined
): boolean {
  return mode !== 'results-and-actions' || (intent !== undefined && intent !== 'progress')
}

type AgentNotificationFacts = Pick<
  AgentStatusEntry,
  | 'state'
  | 'interactivePrompt'
  | 'lastAssistantMessage'
  | 'lastAssistantMessageIsToolOutput'
  | 'sessionBoundary'
  | 'orchestration'
>

export function classifyAgentNotificationIntent(
  entry: AgentNotificationFacts | undefined
): AgentNotificationIntent {
  if (!entry || entry.sessionBoundary === true) {
    return 'progress'
  }
  const orchestration = entry.orchestration
  const categories = orchestration?.attention?.categories ?? []
  if (
    orchestration?.dispatchStatus === 'failed' ||
    orchestration?.dispatchStatus === 'circuit_broken' ||
    categories.some((category) => FAILURE_CATEGORIES.has(category))
  ) {
    return 'failure'
  }
  if (
    Boolean(entry.interactivePrompt?.trim()) ||
    categories.some((category) => ACTION_CATEGORIES.has(category))
  ) {
    return 'action-required'
  }
  if (
    categories.includes('root_completion') ||
    (entry.state === 'done' &&
      entry.lastAssistantMessageIsToolOutput !== true &&
      Boolean(entry.lastAssistantMessage?.trim()))
  ) {
    return 'result'
  }
  return 'progress'
}
