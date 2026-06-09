import type { SettingsSearchEntry } from './settings-search'

export const AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Auto-Rename Branch',
  description: 'Rename the auto-generated branch based on the work once an agent starts.',
  keywords: [
    'branch',
    'rename',
    'auto',
    'creature name',
    'agent',
    'prompt',
    'command',
    'template',
    'worktree',
    'slug',
    'generate'
  ]
}

export const AUTO_RENAME_BRANCH_ADVANCED_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Branch name command template',
    description: 'Agent command template used when generating branch names.',
    keywords: [
      'prompt',
      'instructions',
      'built-in prompt',
      'command',
      'template',
      'slug',
      'kebab-case'
    ]
  }
]

export const AUTO_RENAME_BRANCH_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  AUTO_RENAME_BRANCH_PARENT_SEARCH_ENTRY,
  ...AUTO_RENAME_BRANCH_ADVANCED_SEARCH_ENTRIES
]
