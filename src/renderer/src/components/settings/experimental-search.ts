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
    title: 'Agents View',
    description: 'Threaded left-sidebar feed for agent completions and blocking states.',
    keywords: [
      'experimental',
      'agents',
      'agents view',
      'activity',
      'notifications',
      'worktrees',
      'timeline',
      'unread',
      'bell',
      'sidebar'
    ]
  },
  {
    title: 'Terminal attention',
    description: 'Persistent pane highlight for terminal bell and agent-completion events.',
    keywords: [
      'experimental',
      'terminal',
      'attention',
      'highlight',
      'pane',
      'bell',
      'notification',
      'agent',
      'completion',
      'unread'
    ]
  },
  {
    title: 'Compact worktree cards',
    description: 'Use one-line worktree cards instead of the detailed metadata row.',
    keywords: [
      'experimental',
      'worktree',
      'worktrees',
      'workspace',
      'workspaces',
      'compact',
      'sidebar',
      'cards',
      'branch',
      'metadata'
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
  },
  {
    title: 'Smart New Tab menu',
    description:
      'Type in the New Tab menu to open a terminal, launch an agent, visit a URL, or open/create a file.',
    keywords: [
      'experimental',
      'smart',
      'new tab',
      'new tab menu',
      'launcher',
      'unified',
      'plus',
      'terminal',
      'agents',
      'claude',
      'codex',
      'url',
      'file'
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
  activity: findEntry('Agents View'),
  terminalAttention: findEntry('Terminal attention'),
  compactWorktreeCards: findEntry('Compact worktree cards'),
  symlinks: findEntry('Symlinks on worktrees'),
  unifiedNewTabLauncher: findEntry('Smart New Tab menu')
} as const
