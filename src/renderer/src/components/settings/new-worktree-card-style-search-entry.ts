import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getNewWorktreeCardStyleSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.newWorktreeCardStyle.title',
      'New card style'
    ),
    description: translate(
      'auto.components.settings.experimental.search.newWorktreeCardStyle.description',
      'Preview updated worktree-card layout, metadata placement, card-display menu options, and status presentation.'
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
