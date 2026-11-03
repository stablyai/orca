import { translate } from '@/i18n/i18n'
import type { TerminalTabIntoPaneRefusal } from './terminal-tab-into-pane-eligibility'

/** Why a tab cannot join a pane right now, in the words a disabled menu entry shows. */
export function describeTerminalTabIntoPaneRefusal(reason: TerminalTabIntoPaneRefusal): string {
  switch (reason) {
    case 'source_not_single_pane':
      return translate('terminal.paneMove.reason.sourceNotSinglePane', 'Tab has several panes')
    case 'source_chat':
    case 'target_chat':
      return translate('terminal.paneMove.reason.chat', 'Chat view')
    case 'no_terminal':
      return translate('terminal.paneMove.reason.noTerminal', 'No running terminal')
    case 'pending_spawn':
    case 'launch_pending':
    case 'startup_pending':
      return translate('terminal.paneMove.reason.starting', 'Still starting')
    case 'sleeping':
      return translate('terminal.paneMove.reason.sleeping', 'Pane is asleep')
    case 'pty_exiting':
      return translate('terminal.paneMove.reason.exiting', 'Pane is exiting')
    case 'unverified_pty_loss':
      return translate('terminal.paneMove.reason.unverified', 'Host not confirmed')
    case 'host_authoritative':
      return translate('terminal.paneMove.reason.remote', 'Remote host tab')
    case 'move_in_flight':
      return translate('terminal.paneMove.reason.busy', 'Another move is running')
    case 'layout_owner_build':
    case 'same_tab':
    case 'source_missing':
    case 'target_missing':
    case 'target_pane_missing':
    case 'worktree_mismatch':
      return translate('terminal.paneMove.reason.unavailable', 'Unavailable')
  }
}
