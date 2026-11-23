import type { Translate } from '@/i18n/use-translate'
import type { BranchAutoRenameOutcome } from '../../../../../../shared/worktree/branch-auto-rename-attempt'

/** One plain sentence replacing the error details; null keeps the persisted error. */
export function branchAutoRenameReasonText(
  outcome: BranchAutoRenameOutcome | null,
  t: Translate
): string | null {
  if (!outcome) {
    return null
  }
  switch (outcome.kind) {
    case 'renamed':
    case 'failed':
      return null
    case 'nothing-yet':
      return t(
        'auto.components.sidebar.AutoRenameFailedDialog.reasonNothingYet',
        'No changes to name this branch from yet.'
      )
    case 'deferred':
      switch (outcome.reason) {
        case 'branch-changed':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonBranchChanged',
            'The branch changed while Orca was naming it.'
          )
        case 'project-moving':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonProjectMoving',
            'A project move is in progress.'
          )
        case 'history-unreadable':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonHistoryUnreadable',
            "Orca couldn't read this workspace's history. Try again."
          )
        case 'interrupted':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonInterrupted',
            "Orca couldn't finish naming the branch. Try again."
          )
        case 'default-agent-skipped':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonDefaultAgentSkipped',
            'The default agent skipped auto-naming this branch. Try again to find out why.'
          )
        case 'default-agent-skipped-title':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonDefaultAgentSkippedTitle',
            'The default agent skipped auto-naming this workspace title. Try again to find out why.'
          )
      }
      return null
    case 'ineligible':
      switch (outcome.reason) {
        case 'branch-pushed':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonBranchPushed',
            'The branch was pushed, so Orca kept its name.'
          )
        case 'branch-renamed':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonBranchRenamed',
            'The branch was renamed, so Orca kept its name.'
          )
        case 'name-chosen':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonNameChosen',
            'This branch name was chosen by hand, so Orca kept it.'
          )
        case 'setting-off':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonSettingOff',
            'Branch auto-naming is off in Settings.'
          )
        case 'no-distinct-name':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonNoDistinctName',
            'The generated name matched the current one.'
          )
        case 'first-message-unavailable':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonFirstMessageUnavailable',
            "Orca couldn't find this workspace's first message."
          )
        case 'already-named':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonAlreadyNamed',
            'This workspace was already renamed.'
          )
        case 'unavailable':
          return t(
            'auto.components.sidebar.AutoRenameFailedDialog.reasonUnavailable',
            "Orca can't name this branch anymore."
          )
      }
      return null
  }
}
