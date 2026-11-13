import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  WorkspaceCleanupKeepCause,
  WorkspaceCleanupRuleReason
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import type { WorkspaceCleanupRunTrigger } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { formatWorkspaceCleanupKeepCause } from '../../../../../shared/workspace-cleanup/workspace-cleanup-verdict-labels'

// Localized counterparts of the CLI's verdict labels; a value from a newer host falls back to the CLI's words.

export function formatCleanupRuleReasonBadge(
  reason: WorkspaceCleanupRuleReason,
  t: Translate = translate
): string {
  switch (reason) {
    case 'merged':
      return t('components.settings.workspaceCleanup.reason.merged', 'Merged')
    case 'unchanged':
      return t('components.settings.workspaceCleanup.reason.unchanged', 'Unchanged')
    case 'inactive':
      return t('components.settings.workspaceCleanup.reason.inactive', 'Inactive')
    case 'automation-run':
      return t('components.settings.workspaceCleanup.reason.automationRun', 'Automation run')
    case 'orchestration-worker':
      return t(
        'components.settings.workspaceCleanup.reason.orchestrationWorker',
        'Orchestration worker'
      )
  }
  // A newer host can send a reason this build has no label for.
  return String(reason)
}

export function formatCleanupKeepCause(
  cause: WorkspaceCleanupKeepCause,
  t: Translate = translate
): string {
  switch (cause) {
    case 'pinned':
      return t('components.settings.workspaceCleanup.keep.pinned', 'Pinned')
    case 'no-rule-matched':
      return t('components.settings.workspaceCleanup.keep.noRuleMatched', 'No rule matched')
    case 'recently-active':
      return t('components.settings.workspaceCleanup.keep.recentlyActive', 'Used in the last hour')
    case 'active-workspace':
      return t('components.settings.workspaceCleanup.keep.activeWorkspace', 'Open right now')
    case 'agent-running':
      return t('components.settings.workspaceCleanup.keep.agentRunning', 'Agent running')
    case 'terminal-running':
      return t(
        'components.settings.workspaceCleanup.keep.terminalRunning',
        'Terminal running a process'
      )
    case 'terminal-unknown':
      return t(
        'components.settings.workspaceCleanup.keep.terminalUnknown',
        'Terminal state unknown'
      )
    case 'unsaved-editor-changes':
      return t(
        'components.settings.workspaceCleanup.keep.unsavedEditorChanges',
        'Unsaved editor changes'
      )
    case 'uncommitted-changes':
      return t(
        'components.settings.workspaceCleanup.keep.uncommittedChanges',
        'Uncommitted changes'
      )
    case 'unpushed-commits':
      return t('components.settings.workspaceCleanup.keep.unpushedCommits', 'Unpushed commits')
    case 'ignored-files':
      return t('components.settings.workspaceCleanup.keep.ignoredFiles', 'Ignored files')
    case 'git-unknown':
      return t('components.settings.workspaceCleanup.keep.gitUnknown', "Couldn't read Git status")
    case 'archive-unavailable':
      return t(
        'components.settings.workspaceCleanup.keep.archiveUnavailable',
        'Archive not available'
      )
    case 'archive-script':
      return t('components.settings.workspaceCleanup.keep.archiveScript', 'Has an archive script')
    case 'removing':
      return t('components.settings.workspaceCleanup.keep.removing', 'Already being removed')
    case 'waiting':
      return t('components.settings.workspaceCleanup.keep.waiting', 'Waiting')
    case 'not-removable':
      return t(
        'components.settings.workspaceCleanup.keep.notRemovable',
        'Main workspace or folder project'
      )
    case 'project-off':
      return t(
        'components.settings.workspaceCleanup.keep.projectOff',
        'Cleanup off for this project'
      )
    case 'rules-off':
      return t('components.settings.workspaceCleanup.keep.rulesOff', 'No rule on')
  }
  // A newer host can send a cause this build has no label for; the CLI's words beat nothing.
  return formatWorkspaceCleanupKeepCause(cause)
}

export function formatCleanupRunTrigger(
  trigger: WorkspaceCleanupRunTrigger,
  t: Translate = translate
): string {
  switch (trigger) {
    case 'startup':
      return t('components.settings.workspaceCleanup.trigger.startup', 'On startup')
    case 'hourly':
      return t('components.settings.workspaceCleanup.trigger.hourly', 'Hourly')
    case 'settings':
      return t('components.settings.workspaceCleanup.trigger.settings', 'After a rule change')
    case 'run-now':
      return t('components.settings.workspaceCleanup.trigger.runNow', 'Clean up now')
    case 'cli':
      return t('components.settings.workspaceCleanup.trigger.cli', 'From the CLI')
  }
  return String(trigger)
}
