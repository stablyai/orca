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
  }
]
