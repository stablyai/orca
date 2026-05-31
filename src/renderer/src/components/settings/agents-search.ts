import type { SettingsSearchEntry } from './settings-search'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
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

const AGENT_SETTINGS_KEYWORDS = buildAgentSettingsKeywords()

function buildAgentSettingsKeywords(): string[] {
  const keywords = [
    'agent',
    'default',
    'command',
    'override',
    'install',
    'detected',
    'enable',
    'disable',
    'hide',
    'show',
    'github'
  ]

  for (const agent of AGENT_CATALOG) {
    keywords.push(...expandAgentSearchText(agent.id), ...expandAgentSearchText(agent.label))
    keywords.push(...expandAgentSearchText(agent.cmd))
  }

  return [...new Set(keywords)]
}

function expandAgentSearchText(value: string): string[] {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()

  return spaced === value ? [value] : [value, spaced]
}

export const AGENTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Agents',
    description: 'Configure AI coding agents, default agent, and command overrides.',
    keywords: AGENT_SETTINGS_KEYWORDS
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
