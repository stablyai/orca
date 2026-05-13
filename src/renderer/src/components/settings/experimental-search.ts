import type { SettingsSearchEntry } from './settings-search'

export const EXPERIMENTAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Pet',
    description: 'Floating animated pet in the bottom-right corner.',
    keywords: [
      'experimental',
      'pet',
      'sidekick',
      'mascot',
      'overlay',
      'animated',
      'corner',
      'character'
    ]
  },
  {
    title: 'Activity Page',
    description: 'Slack-style worktree activity feed for agent completions and blocking states.',
    keywords: [
      'experimental',
      'activity',
      'notifications',
      'agents',
      'worktrees',
      'timeline',
      'unread',
      'bell'
    ]
  },
  {
    title: 'Symlinks on worktrees',
    description:
      'Automatically symlink configured files or folders into newly created worktrees so shared state (envs, caches, installs) stays connected.',
    keywords: [
      'experimental',
      'worktree',
      'worktrees',
      'symlink',
      'symlinks',
      'link',
      'links',
      'shared',
      'env',
      'node_modules'
    ]
  }
]

// Why: title-keyed lookup avoids a fragile numeric-index invariant — the array
// shape can change without breaking consumers, and a typo/rename throws loudly
// instead of silently matching the wrong (or empty) entry.
function findEntry(title: string): SettingsSearchEntry {
  const entry = EXPERIMENTAL_PANE_SEARCH_ENTRIES.find((e) => e.title === title)
  if (!entry) {
    throw new Error(`Missing experimental-pane search entry: "${title}"`)
  }
  return entry
}

export const EXPERIMENTAL_SEARCH_ENTRY = {
  pet: findEntry('Pet'),
  activity: findEntry('Activity Page'),
  symlinks: findEntry('Symlinks on worktrees')
} as const
