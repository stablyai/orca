import type { NativeChatSessionOptionDispatchResult } from './native-chat-session-option-dispatch'

// One English table for local session-option refusals; the renderer translates by code.
export const SESSION_OPTION_APPLY_FAILURE_COPY = {
  controlUnavailable: "{{agent}} can't change options from Chat in this session.",
  controlNotSent: '{{agent}} did not receive the option change. Try again.',
  startOnly: 'This option can only be set when the session starts.',
  modelRejected: 'Claude kept the current model.',
  modelUnverified: 'Could not verify the model change; open the terminal to check.',
  unknownOption: 'Unknown session option: {{id}}',
  agentPickerOnly: 'This option must be changed in the agent picker.',
  toggleBaselineUnknown: 'Current value is unknown; use the Toggle action instead.',
  afterStartOnly: 'This option is only available after the session starts.',
  valueRequired: 'This option requires a value.',
  toggleValueKnown: 'This option has a known value; choose On or Off instead.'
} as const

export type SessionOptionApplyFailureCode = keyof typeof SESSION_OPTION_APPLY_FAILURE_COPY

export class SessionOptionApplyError extends Error {
  readonly code: SessionOptionApplyFailureCode
  readonly optionId: string | undefined
  readonly agent: string | undefined

  constructor(code: SessionOptionApplyFailureCode, optionId?: string, agent?: string) {
    super(
      SESSION_OPTION_APPLY_FAILURE_COPY[code]
        .replace('{{id}}', () => optionId ?? '')
        .replace('{{agent}}', () => agent ?? '')
    )
    this.name = 'SessionOptionApplyError'
    this.code = code
    this.optionId = optionId
    this.agent = agent
  }
}

export function assertControlNotBlocked(
  result: NativeChatSessionOptionDispatchResult | void
): void {
  if (result?.outcome === 'blocked') {
    const agent =
      result.agent === 'omp' ? 'OMP' : result.agent.charAt(0).toUpperCase() + result.agent.slice(1)
    throw new SessionOptionApplyError(
      result.reason === 'foreign-draft' || result.reason === 'unsupported-control'
        ? 'controlUnavailable'
        : 'controlNotSent',
      undefined,
      agent
    )
  }
}
