import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'

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
      ].filter(
        (choice) =>
          state.interactionModes === undefined ||
          state.interactionModes.some((mode) => mode === choice.value)
      )
    },
    ...(state.reportedAgent ? { reportedAgent: state.reportedAgent } : {}),
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
  if (draft === '/plan' && ['claude', 'codex', 'opencode', 'opencode2'].includes(agent)) {
    return 'plan'
  }
  return draft === '/default' && agent === 'codex' ? 'default' : null
}

export function offersAgentSessionPlanMode(snapshot: readonly SessionOptionDescriptor[]): boolean {
  const mode = snapshot.find((entry) => entry.id === 'interactionMode')
  return mode?.kind.type === 'select' && mode.kind.choices.some((choice) => choice.value === 'plan')
}
