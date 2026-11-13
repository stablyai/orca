import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repo-types'
import type { SettingsSearchEntry } from '../search/settings-search'
import { searchKeywordTranslator } from '../search/settings-search-keywords'

/** The entries for whether a project is listed: hiding it from the sidebar, or removing it. */
export function getRepositoryPresenceSearchEntries(
  repo: Pick<Repo, 'displayName'>,
  t: Translate = translate
): { sidebarVisibility: SettingsSearchEntry; removeProject: SettingsSearchEntry } {
  const translateSearchKeyword = searchKeywordTranslator(t)
  const removeProject: SettingsSearchEntry = {
    title: t('auto.components.settings.repository.search.bbbe994528', 'Remove project'),
    description: t(
      'auto.components.settings.repository.search.c86478c3d8',
      'Remove this project from Orca.'
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword('auto.components.settings.repository.search.3067595d82', 'delete'),
      ...translateSearchKeyword('auto.components.settings.repository.search.6469de5368', 'project'),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.cc876ca5f2',
        'repository'
      )
    ]
  }
  const sidebarVisibility: SettingsSearchEntry = {
    title: t('sidebar.hiddenProjects.settingsTitle', 'Hide from sidebar'),
    description: t(
      'sidebar.hiddenProjects.settingsDescription',
      "Hides this host's copy of the project from the sidebar, project pickers and the workspace switcher. Its terminals, agents and automations keep running. On a paired Orca server, this hides it for everyone connected to that server."
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword('sidebar.hiddenProjects.keywordHide', 'hide'),
      ...translateSearchKeyword('sidebar.hiddenProjects.keywordHidden', 'hidden'),
      ...translateSearchKeyword('sidebar.hiddenProjects.keywordSidebar', 'sidebar'),
      // Restoring is the same switch, so "show" and "unhide" must find it too.
      ...translateSearchKeyword('sidebar.hiddenProjects.keywordShow', 'show'),
      ...translateSearchKeyword('sidebar.hiddenProjects.keywordUnhide', 'unhide')
    ]
  }
  return { sidebarVisibility, removeProject }
}
