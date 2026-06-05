import type { SettingsSearchEntry } from './settings-search'

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
    'creature name',
    'agent',
    'prompt',
    'worktree',
    'model',
    'slug'
  ]
}

// Why: the toggle lives in Git settings, but its model/prompt customization moved
// under Git AI Author -> Advanced -> Branch Names, so only the toggle is searched here.
export const AUTO_RENAME_BRANCH_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY
]
