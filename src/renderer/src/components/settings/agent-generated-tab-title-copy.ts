import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const AGENT_GENERATED_TAB_TITLES_TITLE_KEY =
  'auto.components.settings.agent-generated-tab-title-copy.19ad21615a'
const AGENT_GENERATED_TAB_TITLES_DESCRIPTION_KEY =
  'auto.components.settings.agent-generated-tab-title-copy.b036c7a409'

export function getAgentGeneratedTabTitlesTitle(): string {
  return translate(AGENT_GENERATED_TAB_TITLES_TITLE_KEY, 'Auto-generate tab titles')
}

export function getAgentGeneratedTabTitlesDescription(): string {
  return translate(
    AGENT_GENERATED_TAB_TITLES_DESCRIPTION_KEY,
    'Derive short stable tab names from the first known agent prompt. Manual renames always win.'
  )
}

export function getAgentGeneratedTabTitlesSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.agents.search.be7ea3553b', fallback: 'tab' },
    { key: 'auto.components.settings.agents.search.6956646a1e', fallback: 'title' },
    { key: 'auto.components.settings.agents.search.32836788b0', fallback: 'generated title' },
    { key: 'auto.components.settings.agents.search.966890236d', fallback: 'name' },
    { key: 'auto.components.settings.agents.search.848dcae8d3', fallback: 'generated' },
    { key: 'auto.components.settings.agents.search.52115d0d7c', fallback: 'auto' },
    { key: 'auto.components.settings.agents.search.c64059f50d', fallback: 'prompt' },
    { key: 'auto.components.settings.agents.search.5784ae8c43', fallback: 'rename' },
    { key: 'auto.components.settings.agents.search.8a17fd6026', fallback: 'stable' },
    { key: 'auto.components.settings.agents.search.a79d266f71', fallback: 'session' },
    { key: 'auto.components.settings.agents.search.afbf35be68', fallback: 'stable session' }
  ])
}
