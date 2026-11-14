import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getNewWorktreeCardStyleSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.worktreeCardStyle.title',
      'Card style'
    ),
    description: translate(
      'auto.components.settings.experimental.search.worktreeCardStyle.description',
      'Choose how workspace cards look in the sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.card',
        'card'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.cards',
        'cards'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.worktree',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.worktrees',
        'worktrees'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.metadata',
        'metadata'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.status',
        'status'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.menu',
        'menu'
      )
    ]
  }
}
