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

type PerforceCatalogEntry = SettingsSearchEntry & { id: PerforceSettingId }

function entry(
  id: PerforceSettingId,
  title: string,
  description: string,
  keywords: string[]
): PerforceCatalogEntry {
  const key = `perforce.settings.${id}`
  return {
    id,
    title: translate(`${key}.title`, title),
    description: translate(`${key}.description`, description),
    keywords
  }
}

export const getPerforceSettingsCatalog = createLocalizedCatalog((): PerforceCatalogEntry[] => [
  entry(
    'p4-path',
    'p4 Executable',
    'Path to the p4 command-line client. Leave empty to find it automatically.',
    ['perforce', 'p4', 'path', 'binary', 'command line']
  ),
  entry(
    'p4-environment',
    'Connection Overrides',
    'Set P4PORT, P4USER, P4CLIENT, or P4CONFIG when they are not provided by p4 set or a P4CONFIG file. Empty fields are left alone. Applies to local and SSH workspaces.',
    ['perforce', 'p4port', 'p4user', 'p4client', 'p4config', 'server', 'environment', 'workspace']
  ),
  entry(
    'p4-ignore',
    'Ignore File',
    'Use an ignore file (P4IGNORE) so ignored files do not appear under New files.',
    ['perforce', 'p4ignore', 'ignore', 'gitignore', 'untracked']
  ),
  entry(
    'timeouts',
    'Command Timeouts',
    'How long ordinary p4 commands and the workspace scan behind Source Control may run before Orca gives up.',
    ['perforce', 'timeout', 'reconcile', 'slow', 'large depot']
  ),
  entry(
    'test-connection',
    'Test Connection',
    'Run p4 info for the current workspace to check the server, user, and client.',
    ['perforce', 'detect', 'refresh', 'connection', 'p4 info', 'login']
  ),
  entry(
    'group-order',
    'Source Control Group Order',
    'Choose which Perforce section appears first: default changelist, numbered changelists, or unopened files.',
    ['perforce', 'group order', 'changelist first', 'source control']
  ),
  entry(
    'unopened-sections',
    'Unopened File Sections',
    'Show files modified on disk but not opened, and new files. Turning both off skips the slow reconcile scan.',
    ['perforce', 'modified not opened', 'new files', 'reconcile', 'performance', 'untracked']
  ),
  entry(
    'refresh-interval',
    'Auto-refresh',
    'How often Source Control and tab markers re-read the workspace. Turn off to refresh manually.',
    ['perforce', 'refresh', 'poll', 'interval', 'auto refresh']
  ),
  entry(
    'compare-against',
    'Compare Against',
    'Diff files against the revision you last synced (#have) or the latest depot revision (#head).',
    ['perforce', 'diff', 'have', 'head', 'compare', 'revision']
  ),
  entry(
    'save-read-only',
    'Saving Files Not Opened for Edit',
    'What happens when you save a read-only workspace file: ask first, open it for edit automatically, or never.',
    ['perforce', 'checkout', 'open for edit', 'read-only', 'save', 'p4 edit']
  ),
  entry(
    'edited-tab-prefix',
    'Edited Tab Marker',
    'Show an E before the name of editor tabs for files opened for edit.',
    ['perforce', 'tab', 'edit marker', 'prefix', 'opened for edit']
  ),
  entry(
    'new-changelist',
    'New Changelists',
    'Description template for new changelists ({user} and {client} are replaced), and whether a new changelist starts empty or takes the selected files.',
    ['perforce', 'changelist', 'template', 'description', 'empty', 'move files']
  ),
  entry(
    'submit-confirmation',
    'Submit Confirmation',
    'Ask before submitting a changelist. Submitting a shelved-only changelist unshelves it first, so that has its own prompt.',
    ['perforce', 'submit', 'confirm', 'shelved only']
  ),
  entry(
    'destructive-confirmation',
    'Confirm Destructive Actions',
    'Ask before reverting files, reverting shelved files, or deleting a changelist.',
    ['perforce', 'revert', 'delete', 'confirm', 'discard']
  ),
  entry(
    'shelf-after-submit',
    'Shelf After Submit',
    'Perforce cannot submit a changelist that still has a shelf. Choose whether the shelf is deleted or first copied into a new shelved changelist.',
    ['perforce', 'shelf', 'shelve', 'keep', 'backup', 'submit']
  ),
  entry(
    'ai-description',
    'AI Changelist Descriptions',
    'Show a button that drafts a changelist description from its diff, with its own agent, model, and instructions (separate from Git).',
    ['perforce', 'ai', 'description', 'agent', 'model', 'prompt', 'instructions', 'generate']
  )
])

export const getPerforcePaneSearchEntries = (): SettingsSearchEntry[] =>
  getPerforceSettingsCatalog().map(({ id: _id, ...searchEntry }) => searchEntry)
