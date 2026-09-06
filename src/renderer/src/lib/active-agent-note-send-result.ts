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

export type ActiveAgentNotesSendFailureCode =
  | 'empty'
  | 'no-note-target'
  | 'no-inventory-match'
  | 'terminal_handle_stale'
  | 'terminal_exited'
  | 'terminal_gone'
  | 'no_active_terminal'
  | 'terminal_wait_not_running'
  | 'terminal_wait_blocked'
  | 'terminal_wait_unsatisfied'
  | 'terminal_wait_timeout'
  | 'no-agent'
  | 'agent-permission'
  | 'status-unavailable'
  | 'terminal-send-permission'
  | 'terminal-send-refused'
  | 'terminal_not_writable'
  | 'submit-readiness-lost'
  | 'submit-terminal-unavailable'
  | 'submit-send-refused'
  | 'submit-send-error'
  | 'runtime-unverifiable'
  | 'runtime-timeout'

export type ActiveAgentNotesSendResult = {
  status: ActiveAgentNotesSendStatus
  code?: ActiveAgentNotesSendFailureCode
}

export function activeAgentNotesSendFailureMessage(
  status: ActiveAgentNotesSendStatus,
  options: { explicitTarget?: boolean; code?: ActiveAgentNotesSendFailureCode } = {}
): string {
  const target = options.explicitTarget ? 'selected' : 'active'
  let message: string
  switch (status) {
    case 'empty':
      message = 'No notes to send.'
      break
    case 'no-active-terminal':
      message = options.explicitTarget
        ? 'The selected terminal is no longer available.'
        : 'Open the agent terminal in this worktree, then send the notes again.'
      break
    case 'no-agent':
      message = `The ${target} terminal is not a recognized agent session.`
      break
    case 'permission':
      message = options.explicitTarget
        ? 'The selected agent needs permission.'
        : 'The active agent needs permission.'
      break
    case 'status-unavailable':
      message = `The ${target} agent status could not be verified.`
      break
    case 'not-ready':
      message = `The ${target} agent was not ready for input yet.`
      break
    case 'not-writable':
      message = `The ${target} terminal did not accept the notes.`
      break
    case 'partial-submit-failed':
      message = options.explicitTarget
        ? 'The notes may already be pasted in the selected terminal, but Orca could not submit them.'
        : 'The notes may already be pasted in the active terminal, but Orca could not submit them.'
      break
    case 'sent':
      message = ''
      break
  }
  return options.code ? `${message} (${options.code})` : message
}
