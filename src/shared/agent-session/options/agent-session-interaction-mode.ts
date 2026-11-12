import type { SessionOptionDescriptor } from '../../native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

export type AgentSessionInteractionMode = 'default' | 'plan'

export function isAgentSessionInteractionMode(
  value: unknown
): value is AgentSessionInteractionMode {
  return value === 'default' || value === 'plan'
}

export function structuredAgentSessionInteractionDescriptor(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor | null {
  if (!state.interactionModeSupported) {
    return null
  }
  const tracked = state.record.values.interactionMode
  return {
    id: 'interactionMode',
    label: 'Mode',
    description: 'Applies to the next turn',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: isAgentSessionInteractionMode(tracked?.value) ? tracked.value : 'default',
      choices: [
        { value: 'default', label: 'Build' },
        { value: 'plan', label: 'Plan' }
      ]
    },
    valueSource: state.acceptedInputSources?.interactionMode
      ? (tracked?.source ?? 'dispatched')
      : 'default',
    transport: 'agent-session',
    settable: true
  }
}

/** Exact commands only; skill picks and unsupported hosts are classified by the caller. */
export function agentSessionInteractionCommand(
  agent: string,
  draft: string
): AgentSessionInteractionMode | null {
  draft = draft.trimEnd()
  if (draft === '/plan' && (agent === 'claude' || agent === 'codex' || agent === 'zcode')) {
    return 'plan'
  }
  return draft === '/default' && (agent === 'codex' || agent === 'zcode') ? 'default' : null
}
