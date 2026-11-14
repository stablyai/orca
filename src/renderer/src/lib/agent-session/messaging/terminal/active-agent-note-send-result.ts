import { agentSessionWriteNoticeEnglish } from '../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { translate } from '@/i18n/i18n'

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
  /** Sent, but nobody could confirm the agent got it: the host may hold it. */
  | 'unconfirmed'

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
  | 'session-send-refused'

export type ActiveAgentNotesSendResult = {
  status: ActiveAgentNotesSendStatus
  code?: ActiveAgentNotesSendFailureCode
}

export function activeAgentNotesSendFailureMessage(
  status: ActiveAgentNotesSendStatus,
  options: {
    explicitTarget?: boolean
    code?: ActiveAgentNotesSendFailureCode
    /** What was being delivered; Add to chat reuses this wording for a selection. */
    subject?: 'notes' | 'selection'
  } = {}
): string {
  const target = options.explicitTarget
    ? translate('components.agentNotes.targetSelected', 'selected')
    : translate('components.agentNotes.targetActive', 'active')
  let message: string
  switch (status) {
    case 'empty':
      message = translate('components.agentNotes.empty', 'No notes to send.')
      break
    case 'no-active-terminal':
      message = options.explicitTarget
        ? translate(
            'components.agentNotes.selectedTerminalUnavailable',
            'The selected terminal is no longer available.'
          )
        : translate(
            'components.agentNotes.activeTerminalUnavailable',
            'Open the agent terminal in this worktree, then send the notes again.'
          )
      break
    case 'no-agent':
      message = translate(
        'components.agentNotes.notAgentSession',
        'The {{target}} terminal is not a recognized agent session.',
        { target }
      )
      break
    case 'permission':
      message = options.explicitTarget
        ? translate(
            'components.agentNotes.selectedAgentNeedsPermission',
            'The selected agent needs permission.'
          )
        : translate(
            'components.agentNotes.activeAgentNeedsPermission',
            'The active agent needs permission.'
          )
      break
    case 'status-unavailable':
      message = translate(
        'components.agentNotes.statusUnverified',
        'The {{target}} agent status could not be verified.',
        { target }
      )
      break
    case 'not-ready':
      message = translate(
        'components.agentNotes.notReady',
        'The {{target}} agent was not ready for input yet.',
        { target }
      )
      break
    case 'not-writable':
      message =
        options.subject === 'selection'
          ? translate(
              'components.agentNotes.notWritableSelection',
              'The {{target}} agent did not accept the selection.',
              { target }
            )
          : translate(
              'components.agentNotes.notWritable',
              'The {{target}} agent did not accept the notes.',
              { target }
            )
      break
    case 'partial-submit-failed':
      message = options.explicitTarget
        ? translate(
            'components.agentNotes.selectedSubmitFailed',
            'The notes may already be pasted in the selected terminal, but Orca could not submit them.'
          )
        : translate(
            'components.agentNotes.activeSubmitFailed',
            'The notes may already be pasted in the active terminal, but Orca could not submit them.'
          )
      break
    case 'unconfirmed':
      message = agentSessionWriteNoticeEnglish(['sendOutcomeLost'])
      break
    case 'sent':
      message = ''
      break
  }
  return options.code ? `${message} (${options.code})` : message
}
