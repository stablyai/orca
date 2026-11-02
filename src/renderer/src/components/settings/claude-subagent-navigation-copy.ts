import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getClaudeSubagentNavigationTitle(): string {
  return translate(
    'auto.components.settings.claudeSubagentNavigation.title',
    'Claude subagent navigation'
  )
}

export function getClaudeSubagentNavigationDescription(): string {
  return translate(
    'auto.components.settings.claudeSubagentNavigation.description',
    'Open Claude subagents from the sidebar. Adds a shortcut to Claude’s keybindings.json and loads an Orca mod in new Orca panes. Requires Claude 2.1.300+ and status hooks. Turning off removes Orca’s shortcut; shortcuts you delete stay deleted.'
  )
}

export function getClaudeSubagentNavigationSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.agents.search.f412abbba5',
      fallback: 'claude',
      englishOnly: true
    },
    {
      key: 'auto.components.settings.claudeSubagentNavigation.search.subagent',
      fallback: 'subagent'
    },
    {
      key: 'auto.components.settings.claudeSubagentNavigation.search.navigation',
      fallback: 'navigation'
    },
    { key: 'auto.components.settings.claudeSubagentNavigation.search.plugin', fallback: 'plugin' },
    { key: 'auto.components.settings.claudeSubagentNavigation.search.mod', fallback: 'mod' },
    {
      key: 'auto.components.settings.claudeSubagentNavigation.search.shortcut',
      fallback: 'shortcut'
    }
  ])
}
