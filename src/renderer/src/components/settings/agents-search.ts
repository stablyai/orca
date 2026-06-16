import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  getAgentAwakeDescription,
  getAgentAwakeSearchKeywords,
  getAgentAwakeTitle
} from './agent-awake-copy'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesSearchKeywords,
  getAgentGeneratedTabTitlesTitle
} from './agent-generated-tab-title-copy'
import {
  getAgentStatusHooksDescription,
  getAgentStatusHooksSearchKeywords,
  getAgentStatusHooksTitle
} from './agent-status-hooks-copy'
import { translate } from '@/i18n/i18n'
import { searchKeywords, translateSearchKeyword, uniqueKeywords } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

function buildAgentSettingsKeywords(): string[] {
  const keywords = searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.agents.search.d8f3a8b8a0', fallback: 'default' },
    { key: 'auto.components.settings.agents.search.167daeb5e9', fallback: 'command' },
    { key: 'auto.components.settings.agents.search.be59907510', fallback: 'override' },
    { key: 'auto.components.settings.agents.search.a6d594c17d', fallback: 'install' },
    { key: 'auto.components.settings.agents.search.f2932bf22b', fallback: 'detected' },
    { key: 'auto.components.settings.agents.search.2afd3b5858', fallback: 'enable' },
    { key: 'auto.components.settings.agents.search.60393e1b17', fallback: 'disable' },
    { key: 'auto.components.settings.agents.search.2e188c771c', fallback: 'hide' },
    { key: 'auto.components.settings.agents.search.87fffe6c20', fallback: 'show' },
    { key: 'auto.components.settings.agents.search.permission', fallback: 'permission' },
    { key: 'auto.components.settings.agents.search.permissions', fallback: 'permissions' },
    { key: 'auto.components.settings.agents.search.yolo', fallback: 'yolo', englishOnly: true },
    { key: 'auto.components.settings.agents.search.manual', fallback: 'manual' },
    {
      key: 'auto.components.settings.agents.search.e2b7c0dcd7',
      fallback: 'github',
      englishOnly: true
    }
  ])

  for (const agent of getAgentCatalog()) {
    keywords.push(...expandAgentSearchText(agent.id), ...expandAgentSearchText(agent.label))
    keywords.push(...expandAgentSearchText(agent.cmd))
  }

  return uniqueKeywords(keywords)
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
    keywords: buildAgentSettingsKeywords()
  },
  {
    title: translate('auto.components.settings.agents.search.ef804b7337', 'Agent Location'),
    description: translate(
      'auto.components.settings.agents.search.cbdd7f3b9e',
      'Choose whether installed agents are detected on this device or in WSL.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.96ba2373b6', 'agent'),
      ...translateSearchKeyword('auto.components.settings.agents.search.d2952dfd74', 'location'),
      ...translateSearchKeyword('auto.components.settings.agents.search.77c02fa3c3', 'windows'),
      ...translateSearchKeyword('auto.components.settings.agents.search.d608654c03', 'wsl'),
      ...translateSearchKeyword('auto.components.settings.agents.search.f622b8eb2a', 'linux'),
      ...translateSearchKeyword('auto.components.settings.agents.search.839e82c81f', 'detect'),
      ...translateSearchKeyword('auto.components.settings.agents.search.2814401339', 'installed'),
      ...translateSearchKeyword('auto.components.settings.agents.search.719f53350c', 'path')
    ]
  },
  {
    title: getAgentStatusHooksTitle(),
    description: getAgentStatusHooksDescription(),
    keywords: getAgentStatusHooksSearchKeywords()
  },
  {
    title: getAgentGeneratedTabTitlesTitle(),
    description: getAgentGeneratedTabTitlesDescription(),
    keywords: getAgentGeneratedTabTitlesSearchKeywords()
  },
  {
    title: getAgentAwakeTitle(),
    description: getAgentAwakeDescription(),
    keywords: getAgentAwakeSearchKeywords()
  },
  {
    title: translate(
      'auto.components.settings.agents.search.agentPermissions',
      'Agent Permissions'
    ),
    description: translate(
      'auto.components.settings.agents.search.agentPermissionsDescription',
      'Switch agent permission defaults between Yolo and Manual.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.permission', 'permission'),
      ...translateSearchKeyword(
        'auto.components.settings.agents.search.permissions',
        'permissions'
      ),
      ...translateSearchKeyword('auto.components.settings.agents.search.yolo', 'yolo'),
      ...translateSearchKeyword('auto.components.settings.agents.search.manual', 'manual'),
      ...translateSearchKeyword('auto.components.settings.agents.search.skip', 'skip'),
      ...translateSearchKeyword('auto.components.settings.agents.search.checks', 'checks')
    ]
  }
])
