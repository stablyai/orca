import type { SettingsSearchEntry } from './settings-search'

export const AGENTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Agents',
    description: 'Configure AI coding agents, default agent, and command overrides.',
    keywords: [
      'agent',
      'default',
      'claude',
      'codex',
      'opencode',
      'pi',
      'gemini',
      'aider',
      'goose',
      'amp',
      'kilocode',
      'kiro',
      'charm',
      'auggie',
      'cline',
      'codebuff',
      'continue',
      'cursor',
      'droid',
      'kimi',
      'mistral',
      'qwen',
      'rovo',
      'hermes',
      'openclaw',
      'copilot',
      'grok',
      'github',
      'github copilot',
      'command',
      'override',
      'install',
      'detected'
    ]
  },
  {
    title: 'Keep computer awake while agents are working',
    description:
      'Keeps this computer and display awake while agents are working. On macOS, Orca also asks the system to stay awake when the lid is closed, but closed-lid support still depends on OS and hardware power policy.',
    keywords: ['awake', 'sleep', 'power', 'agent', 'running', 'working', 'lid', 'display']
  }
]
