import { translate } from '@/i18n/i18n'
import { searchKeywords } from '../../search/settings-search-keywords'

export function getClaudeSessionNameSyncTitle(): string {
  return translate(
    'settings.agents.claudeSessionNameSync.title',
    'Sync tab names with Claude Code sessions'
  )
}

export function getClaudeSessionNameSyncDescription(): string {
  return translate(
    'settings.agents.claudeSessionNameSync.description',
    'Renaming a tab that runs Claude Code also renames its session, as /rename does, and /rename in Claude Code renames the tab.'
  )
}

export function getClaudeSessionNameSyncSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.agents.search.f412abbba5',
      fallback: 'claude',
      englishOnly: true
    },
    { key: 'auto.components.settings.agents.search.be7ea3553b', fallback: 'tab' },
    { key: 'auto.components.settings.agents.search.6956646a1e', fallback: 'title' },
    { key: 'auto.components.settings.agents.search.966890236d', fallback: 'name' },
    { key: 'auto.components.settings.agents.search.5784ae8c43', fallback: 'rename' },
    { key: 'auto.components.settings.agents.search.a79d266f71', fallback: 'session' }
  ])
}
