import type { SettingsSearchEntry } from './settings-search'
import {
  AGENT_AWAKE_TITLE,
  getAgentAwakeDescription,
  getAgentAwakeSearchKeywords
} from './agent-awake-copy'
import {
  AGENT_GENERATED_TAB_TITLES_DESCRIPTION,
  AGENT_GENERATED_TAB_TITLES_SEARCH_KEYWORDS,
  AGENT_GENERATED_TAB_TITLES_TITLE
} from './agent-generated-tab-title-copy'
import {
  AGENT_STATUS_HOOKS_DESCRIPTION,
  AGENT_STATUS_HOOKS_SEARCH_KEYWORDS,
  AGENT_STATUS_HOOKS_TITLE
} from './agent-status-hooks-copy'

export const AGENTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Agents',
    description: 'Configure AI coding agents, default agent, and command overrides.',
    keywords: [
      'agent',
      'default',
      'claude',
      'openclaude',
      'open claude',
      'codex',
      'opencode',
      'pi',
      'omp',
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
      'command code',
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
      'detected',
      'enable',
      'disable',
      'hide',
      'show'
    ]
  },
  {
    title: 'Agent Location',
    description: 'Choose whether installed agents are detected on this device or in WSL.',
    keywords: ['agent', 'location', 'windows', 'wsl', 'linux', 'detect', 'installed', 'path']
  },
  {
    title: AGENT_STATUS_HOOKS_TITLE,
    description: AGENT_STATUS_HOOKS_DESCRIPTION,
    keywords: AGENT_STATUS_HOOKS_SEARCH_KEYWORDS
  },
  {
    title: AGENT_GENERATED_TAB_TITLES_TITLE,
    description: AGENT_GENERATED_TAB_TITLES_DESCRIPTION,
    keywords: AGENT_GENERATED_TAB_TITLES_SEARCH_KEYWORDS
  },
  {
    title: AGENT_AWAKE_TITLE,
    description: getAgentAwakeDescription(),
    keywords: getAgentAwakeSearchKeywords()
  }
]
