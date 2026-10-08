import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export type PerforceSettingId =
  | 'p4-path'
  | 'p4-environment'
  | 'p4-ignore'
  | 'timeouts'
  | 'test-connection'
  | 'group-order'
  | 'unopened-sections'
  | 'refresh-interval'
  | 'compare-against'
  | 'save-read-only'
  | 'edited-tab-prefix'
  | 'new-changelist'
  | 'submit-confirmation'
  | 'destructive-confirmation'
  | 'shelf-after-submit'
  | 'ai-description'
  | 'workspace-copies'

type PerforceCatalogEntry = SettingsSearchEntry & { id: PerforceSettingId }

function entry(
  id: PerforceSettingId,
  title: string,
  description: string,
  keywords: string[]
): PerforceCatalogEntry {
  return { id, title, description, keywords }
}

export const getPerforceSettingsCatalog = createLocalizedCatalog((): PerforceCatalogEntry[] => [
  entry(
    'p4-path',
    translate('perforce.settings.p4-path.title', 'p4 Executable'),
    translate(
      'perforce.settings.p4-path.description',
      'Path to the p4 command-line client. Leave empty to find it automatically.'
    ),
    ['perforce', 'p4', 'path', 'binary', 'command line']
  ),
  entry(
    'p4-environment',
    translate('perforce.settings.p4-environment.title', 'Connection Overrides'),
    translate(
      'perforce.settings.p4-environment.description',
      'Set P4PORT, P4USER, P4CLIENT, or P4CONFIG when they are not provided by p4 set or a P4CONFIG file. Empty fields are left alone. Applies to local and SSH workspaces.'
    ),
    ['perforce', 'p4port', 'p4user', 'p4client', 'p4config', 'server', 'environment', 'workspace']
  ),
  entry(
    'p4-ignore',
    translate('perforce.settings.p4-ignore.title', 'Ignore File'),
    translate(
      'perforce.settings.p4-ignore.description',
      'Use an ignore file (P4IGNORE) so ignored files do not appear under New files.'
    ),
    ['perforce', 'p4ignore', 'ignore', 'gitignore', 'untracked']
  ),
  entry(
    'timeouts',
    translate('perforce.settings.timeouts.title', 'Command Timeouts'),
    translate(
      'perforce.settings.timeouts.description',
      'How long ordinary p4 commands and the workspace scan behind Source Control may run before Orca gives up.'
    ),
    ['perforce', 'timeout', 'reconcile', 'slow', 'large depot']
  ),
  entry(
    'test-connection',
    translate('perforce.settings.test-connection.title', 'Test Connection'),
    translate(
      'perforce.settings.test-connection.description',
      'Run p4 info for the current workspace to check the server, user, and client.'
    ),
    ['perforce', 'detect', 'refresh', 'connection', 'p4 info', 'login']
  ),
  entry(
    'group-order',
    translate('perforce.settings.group-order.title', 'Source Control Group Order'),
    translate(
      'perforce.settings.group-order.description',
      'Choose which Perforce section appears first: default changelist, numbered changelists, or unopened files.'
    ),
    ['perforce', 'group order', 'changelist first', 'source control']
  ),
  entry(
    'unopened-sections',
    translate('perforce.settings.unopened-sections.title', 'Unopened File Sections'),
    translate(
      'perforce.settings.unopened-sections.description',
      'Show files modified on disk but not opened, and new files. Turning both off skips the slow reconcile scan.'
    ),
    ['perforce', 'modified not opened', 'new files', 'reconcile', 'performance', 'untracked']
  ),
  entry(
    'refresh-interval',
    translate('perforce.settings.refresh-interval.title', 'Auto-refresh'),
    translate(
      'perforce.settings.refresh-interval.description',
      'How often Source Control and tab markers re-read the workspace. The scan for unopened files then rests three times as long as it took, so a large workspace is scanned less often. Turn off to refresh manually.'
    ),
    ['perforce', 'refresh', 'poll', 'interval', 'auto refresh']
  ),
  entry(
    'compare-against',
    translate('perforce.settings.compare-against.title', 'Compare Against'),
    translate(
      'perforce.settings.compare-against.description',
      'Diff files against the revision you last synced (#have) or the latest depot revision (#head).'
    ),
    ['perforce', 'diff', 'have', 'head', 'compare', 'revision']
  ),
  entry(
    'save-read-only',
    translate('perforce.settings.save-read-only.title', 'Saving Files Not Opened for Edit'),
    translate(
      'perforce.settings.save-read-only.description',
      'What happens when you save a read-only workspace file: ask first, open it for edit automatically, or never.'
    ),
    ['perforce', 'checkout', 'open for edit', 'read-only', 'save', 'p4 edit']
  ),
  entry(
    'edited-tab-prefix',
    translate('perforce.settings.edited-tab-prefix.title', 'Edited Tab Marker'),
    translate(
      'perforce.settings.edited-tab-prefix.description',
      'Show an E before the name of editor tabs for files opened for edit.'
    ),
    ['perforce', 'tab', 'edit marker', 'prefix', 'opened for edit']
  ),
  entry(
    'new-changelist',
    translate('perforce.settings.new-changelist.title', 'New Changelists'),
    translate(
      'perforce.settings.new-changelist.description',
      'Description template for new changelists ({user} and {client} are replaced), and whether a new changelist starts empty or takes the selected files.'
    ),
    ['perforce', 'changelist', 'template', 'description', 'empty', 'move files']
  ),
  entry(
    'submit-confirmation',
    translate('perforce.settings.submit-confirmation.title', 'Submit Confirmation'),
    translate(
      'perforce.settings.submit-confirmation.description',
      'Ask before submitting a changelist. Submitting a shelved-only changelist unshelves it first, so that has its own prompt.'
    ),
    ['perforce', 'submit', 'confirm', 'shelved only']
  ),
  entry(
    'destructive-confirmation',
    translate('perforce.settings.destructive-confirmation.title', 'Confirm Destructive Actions'),
    translate(
      'perforce.settings.destructive-confirmation.description',
      'Ask before reverting files, reverting shelved files, or deleting a changelist.'
    ),
    ['perforce', 'revert', 'delete', 'confirm', 'discard']
  ),
  entry(
    'shelf-after-submit',
    translate('perforce.settings.shelf-after-submit.title', 'Shelf After Submit'),
    translate(
      'perforce.settings.shelf-after-submit.description',
      'Perforce cannot submit a changelist that still has a shelf. Choose whether the shelf is deleted or first copied into a new shelved changelist.'
    ),
    ['perforce', 'shelf', 'shelve', 'keep', 'backup', 'submit']
  ),
  entry(
    'ai-description',
    translate('perforce.settings.ai-description.title', 'AI Changelist Descriptions'),
    translate(
      'perforce.settings.ai-description.description',
      'Show a button that drafts a changelist description from its diff, with its own agent, model, and instructions (separate from Git).'
    ),
    ['perforce', 'ai', 'description', 'agent', 'model', 'prompt', 'instructions', 'generate']
  ),
  entry(
    'workspace-copies',
    translate('perforce.settings.workspace-copies.title', 'Workspace Copies'),
    translate(
      'perforce.settings.workspace-copies.description',
      'Copies of a stream workspace that Create workspace makes in a Perforce project; they need Windows 11 24H2 or later with the workspace on a Dev Drive. What a copy leaves out and how much free space to keep.'
    ),
    [
      'perforce',
      'copy',
      'worktree',
      'dev drive',
      'refs',
      'windows 11',
      'unity',
      'clone',
      'workspace'
    ]
  )
])

export const getPerforcePaneSearchEntries = (): SettingsSearchEntry[] =>
  getPerforceSettingsCatalog().map(({ id: _id, ...searchEntry }) => searchEntry)
