import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getFloatingWorkspaceSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.floating.workspace.search.b2b60e7163',
      'Floating Workspace'
    ),
    description: translate(
      'auto.components.settings.floating.workspace.search.b96b5ee6cf',
      'Enable the floating workspace, choose where new tabs start, and choose where the toggle button appears.'
    ),
    keywords: [
      translate(
        'auto.components.settings.floating.workspace.search.a08e482f6d',
        'floating workspace'
      ),
      translate(
        'auto.components.settings.floating.workspace.search.6f183fa1b9',
        'floating terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.ebeedb2f6a',
        'quick terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.2b5efa55c9',
        'global'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.6410fe83d8',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.49db74a92d',
        'browser'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.884e5e6132',
        'markdown'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.156ffeee08',
        'note'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.52db6e3baf',
        'notes'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.a38bfc3f77',
        'quick panel'
      ),
      translate(
        'auto.components.settings.floating.workspace.search.6765b85e48',
        'launch directory'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.a452146574',
        'toggle button'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.floating.workspace.search.94f4d013c8',
        'status bar'
      )
    ]
  }
])
