import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getSideBySideWorkspacesSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.sideBySideWorkspaces.title',
      'Side-by-side workspaces'
    ),
    description: translate(
      'auto.components.settings.experimental.search.sideBySideWorkspaces.description',
      'Show terminals from several projects at once by splitting the main area into per-project panes.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.split',
        'split'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.sideBySide',
        'side by side'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.multiProject',
        'multi project'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.panes',
        'panes'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.grid',
        'grid'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.worktrees',
        'worktrees'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sideBySideWorkspaces.projects',
        'projects'
      )
    ]
  }
}
