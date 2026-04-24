import type { SettingsSearchEntry } from './settings-search'

export const EXPERIMENTAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Persistent terminal sessions',
    description:
      'Keeps terminal sessions alive across app restarts via a background daemon. Experimental — some sessions may become unresponsive.',
    keywords: [
      'experimental',
      'terminal',
      'daemon',
      'persistent',
      'background',
      'sessions',
      'restart',
      'scrollback',
      'reattach'
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
