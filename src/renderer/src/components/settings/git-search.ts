import type { SettingsSearchEntry } from './settings-search'
import { AUTO_RENAME_BRANCH_SEARCH_ENTRIES } from './auto-rename-branch-search'

export const GIT_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Branch Prefix',
    description: 'Prefix added to branch names when creating worktrees.',
    keywords: ['branch naming', 'git username', 'custom']
  },
  {
    title: 'Keep Local Main Up to Date',
    description:
      'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as main or master. This keeps commands like git diff main...HEAD from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.',
    keywords: [
      'main',
      'master',
      'origin/main',
      'git diff',
      'behind main',
      'up to date',
      'stale main',
      'refresh local main',
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
    title: 'GitLab API Budget',
    description: 'Current GitLab CLI REST rate-limit headers when available.',
    keywords: ['gitlab', 'glab', 'rate limit', 'api budget']
  },
  {
    title: 'Orca Attribution',
    description: 'Add Orca attribution to commits, PRs, and issues.',
    keywords: ['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']
  }
]
