import type { SettingsSearchEntry } from './settings-search'

export const EXPERIMENTAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  // Why: index 0 is preserved as a placeholder for the removed
  // "Detailed agent activity" toggle. Entries downstream
  // (ExperimentalPane.tsx) reference [1] Mobile, [2] Sidekick,
  // [3] Orchestration, [4] Worktree symlinks by numeric index — keeping
  // this slot prevents a search-index shift. Unused; do not match.
  {
    title: '',
    description: '',
    keywords: []
  },
  {
    title: 'Mobile Pairing',
    description:
      'Pair a mobile device to control Orca remotely. Experimental — requires the Orca mobile APK from GitHub Releases.',
    keywords: [
      'experimental',
      'mobile',
      'phone',
      'pair',
      'qr',
      'code',
      'scan',
      'remote',
      'android',
      'apk'
    ]
  },
  {
    title: 'Sidekick',
    description: 'Floating animated sidekick in the bottom-right corner.',
    keywords: [
      'experimental',
      'sidekick',
      'pet',
      'mascot',
      'overlay',
      'animated',
      'corner',
      'character'
    ]
  },
  {
    title: 'Agent Orchestration',
    description:
      'Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates.',
    keywords: [
      'experimental',
      'orchestration',
      'multi-agent',
      'agents',
      'coordination',
      'messaging',
      'dispatch',
      'task',
      'DAG',
      'worker',
      'coordinator'
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
