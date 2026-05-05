import type { SettingsSearchEntry } from './settings-search'

export const GIT_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Branch Prefix',
    description: 'Prefix added to branch names when creating worktrees.',
    keywords: ['branch naming', 'git username', 'custom']
  },
  {
    title: 'Refresh Local Base Ref',
    description: 'Optionally fast-forward local main or master when creating worktrees.',
    keywords: ['main', 'master', 'origin/main', 'git diff', 'base ref', 'worktree']
  },
  {
    title: 'Orca Attribution',
    description: 'Add Orca attribution to commits, PRs, and issues.',
    keywords: ['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']
  }
]
