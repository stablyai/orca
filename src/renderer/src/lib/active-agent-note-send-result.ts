export type ActiveAgentNotesSendStatus =
  | 'sent'
  | 'empty'
  | 'no-active-terminal'
  | 'no-agent'
  | 'permission'
  | 'status-unavailable'
  | 'not-ready'
  | 'not-writable'
  | 'partial-submit-failed'

export type ActiveAgentNotesSendResult = {
  status: ActiveAgentNotesSendStatus
}

export function activeAgentNotesSendFailureMessage(
  status: ActiveAgentNotesSendStatus,
  options: { explicitTarget?: boolean } = {}
): string {
  const target = options.explicitTarget ? 'selected' : 'active'
  switch (status) {
    case 'empty':
      return 'No notes to send.'
    case 'no-active-terminal':
      return options.explicitTarget
        ? 'The selected terminal is no longer available.'
        : 'Open the agent terminal in this worktree, then send the notes again.'
    case 'no-agent':
      return `The ${target} terminal is not a recognized agent session.`
    case 'permission':
      return options.explicitTarget
        ? 'The selected agent needs permission.'
        : 'The active agent needs permission.'
    case 'status-unavailable':
      return `The ${target} agent status could not be verified.`
    case 'not-ready':
      return `The ${target} agent was not ready for input yet.`
    case 'not-writable':
      return `The ${target} terminal did not accept the notes.`
    case 'partial-submit-failed':
      return options.explicitTarget
        ? 'The notes may already be pasted in the selected terminal, but Orca could not submit them.'
        : 'The notes may already be pasted in the active terminal, but Orca could not submit them.'
    case 'sent':
      return ''
  }
}
