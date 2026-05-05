import type { SettingsSearchEntry } from './settings-search'

export const EXPERIMENTAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Detailed agent activity',
    description:
      'Shows each agent’s live status, prompt, and last message inside its workspace card. Experimental — managed hook installs require an app restart.',
    keywords: [
      'experimental',
      'agent',
      'activity',
      'status',
      'live',
      'workspace',
      'card',
      'inline',
      'hook',
      'claude',
      'codex',
      'gemini',
      'sidebar'
    ]
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
