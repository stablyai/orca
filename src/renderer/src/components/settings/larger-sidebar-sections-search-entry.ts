import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getLargerSidebarSectionsSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.largerSidebarSections.title',
      'Larger sidebar sections'
    ),
    description: translate(
      'auto.components.settings.experimental.search.largerSidebarSections.description',
      'Preview larger project and section headers in the worktree sidebar, including repo icons.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.sidebar',
        'sidebar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.sections',
        'sections'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.projects',
        'projects'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.headers',
        'headers'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.typography',
        'typography'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.icons',
        'icons'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.largerSidebarSections.repo',
        'repo'
      )
    ]
  }
}
