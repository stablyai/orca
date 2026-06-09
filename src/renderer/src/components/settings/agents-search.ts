import { getAgentCatalog } from '@/lib/agent-catalog'
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
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

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

  for (const agent of getAgentCatalog()) {
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

export const getAgentsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.agents.search.bb9ad95777', 'Agents'),
    description: translate(
      'auto.components.settings.agents.search.01926b9d8c',
      'Configure AI coding agents, default agent, and command overrides.'
    ),
    keywords: AGENT_SETTINGS_KEYWORDS
  },
  {
    title: translate('auto.components.settings.agents.search.ef804b7337', 'Agent Location'),
    description: translate(
      'auto.components.settings.agents.search.cbdd7f3b9e',
      'Choose whether installed agents are detected on this device or in WSL.'
    ),
    keywords: [
      translate('auto.components.settings.agents.search.96ba2373b6', 'agent'),
      translate('auto.components.settings.agents.search.d2952dfd74', 'location'),
      translate('auto.components.settings.agents.search.77c02fa3c3', 'windows'),
      translate('auto.components.settings.agents.search.d608654c03', 'wsl'),
      translate('auto.components.settings.agents.search.f622b8eb2a', 'linux'),
      translate('auto.components.settings.agents.search.839e82c81f', 'detect'),
      translate('auto.components.settings.agents.search.2814401339', 'installed'),
      translate('auto.components.settings.agents.search.719f53350c', 'path')
    ]
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
])
