import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'

export function structuredAgentSessionAgentDescriptor(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor | null {
  return state.agents
    ? {
        id: 'agent',
        label: 'Agent',
        category: 'mode',
        kind: {
          type: 'select',
          currentValue: state.agentIntent ?? state.reportedAgent,
          choices: state.agents.map(({ id, label, description }) => ({
            value: id,
            label,
            ...(description ? { description } : {})
          }))
        },
        valueSource: state.agentIntent
          ? 'dispatched'
          : state.reportedAgent
            ? 'reported'
            : 'unknown',
        transport: 'agent-session',
        settable: true
      }
    : null
}
