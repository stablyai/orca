import type { SettingsSearchEntry } from './settings-search'

// The auto-name toggle lives in the Git AI Author pane (it depends on that
// feature being enabled); its model/prompt tuning is under Advanced → Branch
// Names. This identity entry is searched as part of that pane's search set.
export const AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Auto-Name From First Message',
  description: 'Use the first task to name blank new workspaces and their unpublished branches.',
  keywords: [
    'workspace',
    'title',
    'branch',
    'rename',
    'name',
    'auto',
    'auto-name',
    'creature name',
    'agent',
    'prompt',
    'worktree',
    'model',
    'slug'
  ]
}
