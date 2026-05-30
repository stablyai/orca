import type { SettingsSearchEntry } from './settings-search'
import {
  AGENT_AWAKE_TITLE,
  getAgentAwakeDescription,
  getAgentAwakeSearchKeywords
} from './agent-awake-copy'
import {
  AGENT_STATUS_HOOKS_DESCRIPTION,
  AGENT_STATUS_HOOKS_SEARCH_KEYWORDS,
  AGENT_STATUS_HOOKS_TITLE
} from './agent-status-hooks-copy'
import {
  SIDEBAR_QUICK_CREATE_DESCRIPTION,
  SIDEBAR_QUICK_CREATE_SEARCH_KEYWORDS,
  SIDEBAR_QUICK_CREATE_TITLE
} from './agent-workflow-shortcuts-copy'

export const AGENTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Agents',
    description: 'Configure coding agents, default agent, launch shortcuts, and command overrides.',
    keywords: [
      'agent',
      'default',
      'claude',
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
      'quick create',
      'quick launch',
      'shortcut',
      'install',
      'detected',
      'enable',
      'disable',
      'hide',
      'show'
    ]
  },
  {
    title: SIDEBAR_QUICK_CREATE_TITLE,
    description: SIDEBAR_QUICK_CREATE_DESCRIPTION,
    keywords: SIDEBAR_QUICK_CREATE_SEARCH_KEYWORDS
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
    title: AGENT_AWAKE_TITLE,
    description: getAgentAwakeDescription(),
    keywords: getAgentAwakeSearchKeywords()
  }
]
