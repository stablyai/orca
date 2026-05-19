import type { SettingsSearchEntry } from './settings-search'
import {
  AGENT_AWAKE_TITLE,
  getAgentAwakeDescription,
  getAgentAwakeSearchKeywords
} from './agent-awake-copy'

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
    title: AGENT_AWAKE_TITLE,
    description: getAgentAwakeDescription(),
    keywords: getAgentAwakeSearchKeywords()
  }
]
