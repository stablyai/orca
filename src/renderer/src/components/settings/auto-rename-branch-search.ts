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

export const AUTO_RENAME_BRANCH_ADVANCED_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Branch name prompt',
    description: 'Additional prompt text appended only when generating branch names.',
    keywords: ['prompt', 'instructions', 'built-in prompt', 'slug', 'kebab-case']
  },
  {
    title: 'Branch name model',
    description: 'Use a different model for branch name generation.',
    keywords: ['model', 'override', 'thinking']
  }
]

export const AUTO_RENAME_BRANCH_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY,
  ...AUTO_RENAME_BRANCH_ADVANCED_SEARCH_ENTRIES
]
