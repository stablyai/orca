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
    title: 'Agent dashboard',
    description:
      'Live cross-worktree view of agent activity, plus retention of finished runs in the sidebar hover. Experimental — managed hook installs require an app restart.',
    keywords: [
      'experimental',
      'agent',
      'dashboard',
      'status',
      'activity',
      'worktree',
      'hook',
      'claude',
      'codex',
      'gemini',
      'sidebar'
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
  }
]
