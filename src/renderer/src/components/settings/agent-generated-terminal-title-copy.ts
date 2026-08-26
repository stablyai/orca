import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const AGENT_GENERATED_TERMINAL_TITLES_TITLE_KEY =
  'components.settings.agentGeneratedTerminalTitles.title'
const AGENT_GENERATED_TERMINAL_TITLES_DESCRIPTION_KEY =
  'components.settings.agentGeneratedTerminalTitles.description'

export function getAgentGeneratedTerminalTitlesTitle(): string {
  return translate(AGENT_GENERATED_TERMINAL_TITLES_TITLE_KEY, 'Auto-generate terminal titles')
}

export function getAgentGeneratedTerminalTitlesDescription(): string {
  return translate(
    AGENT_GENERATED_TERMINAL_TITLES_DESCRIPTION_KEY,
    'Name each terminal in a split from the agent running in it, so a tab full of sessions reads at a glance. Manual renames always win.'
  )
}

export function getAgentGeneratedTerminalTitlesSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    {
      key: 'components.settings.agentGeneratedTerminalTitles.keyword.terminal',
      fallback: 'terminal'
    },
    { key: 'components.settings.agentGeneratedTerminalTitles.keyword.pane', fallback: 'pane' },
    { key: 'components.settings.agentGeneratedTerminalTitles.keyword.split', fallback: 'split' },
    { key: 'auto.components.settings.agents.search.6956646a1e', fallback: 'title' },
    { key: 'auto.components.settings.agents.search.966890236d', fallback: 'name' },
    { key: 'auto.components.settings.agents.search.848dcae8d3', fallback: 'generated' },
    { key: 'auto.components.settings.agents.search.52115d0d7c', fallback: 'auto' },
    { key: 'auto.components.settings.agents.search.c64059f50d', fallback: 'prompt' },
    { key: 'auto.components.settings.agents.search.5784ae8c43', fallback: 'rename' },
    { key: 'auto.components.settings.agents.search.a79d266f71', fallback: 'session' }
  ])
}
