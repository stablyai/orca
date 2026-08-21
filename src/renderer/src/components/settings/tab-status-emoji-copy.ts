import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const TAB_STATUS_EMOJI_TITLE_KEY = 'auto.components.settings.tab-status-emoji-copy.title'
const TAB_STATUS_EMOJI_DESCRIPTION_KEY =
  'auto.components.settings.tab-status-emoji-copy.description'

export function getTabStatusEmojiTitle(): string {
  return translate(TAB_STATUS_EMOJI_TITLE_KEY, 'Show agent state in tab titles')
}

export function getTabStatusEmojiDescription(): string {
  return translate(
    TAB_STATUS_EMOJI_DESCRIPTION_KEY,
    'Prefix a tab with ⚙ while its agent works, ✋ when it needs you, and ✅ when it finishes.'
  )
}

export function getTabStatusEmojiSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.agents.search.be7ea3553b', fallback: 'tab' },
    { key: 'auto.components.settings.agents.search.6956646a1e', fallback: 'title' },
    { key: 'auto.components.settings.tab.status.emoji.emoji', fallback: 'emoji' },
    { key: 'auto.components.settings.tab.status.emoji.status', fallback: 'status' },
    { key: 'auto.components.settings.tab.status.emoji.indicator', fallback: 'indicator' },
    { key: 'auto.components.settings.tab.status.emoji.working', fallback: 'working' },
    { key: 'auto.components.settings.tab.status.emoji.done', fallback: 'done' }
  ])
}
