import type { SettingsSearchEntry } from './settings-search'
import { AUTO_RENAME_BRANCH_SEARCH_ENTRIES } from './auto-rename-branch-search'

export const GIT_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Branch Prefix',
    description: 'Prefix added to branch names when creating worktrees.',
    keywords: ['branch naming', 'git username', 'custom']
  },
  {
    title: 'Refresh Local Base Ref',
    description: 'Safely fast-forward local main or master so AI tools and diffs use a fresh base.',
    keywords: [
      'main',
      'master',
      'origin/main',
      'git diff',
      'base ref',
      'fresh base',
      'safely',
      'worktree'
    ]
  },
  ...AUTO_RENAME_BRANCH_SEARCH_ENTRIES,
  {
    title: 'GitHub API Budget',
    description: 'Current GitHub CLI REST, Search, and GraphQL rate limits.',
    keywords: ['github', 'gh', 'graphql', 'rate limit', 'api budget']
  },
  {
    title: 'Orca Attribution',
    description: 'Add Orca attribution to commits, PRs, and issues.',
    keywords: ['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']
  }
]
