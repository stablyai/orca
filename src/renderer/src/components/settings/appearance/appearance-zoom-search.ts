import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getZoomEntries = createLocalizedCatalog(() => {
  const keywords = [
    ...translateSearchKeyword('auto.components.settings.appearance.search.37e6b58b0e', 'UI zoom'),
    ...translateSearchKeyword('auto.components.settings.appearance.search.3ae5de6101', 'zoom'),
    ...translateSearchKeyword('auto.components.settings.appearance.search.0952091186', 'scale'),
    ...translateSearchKeyword('auto.components.settings.appearance.search.0c83659f48', 'shortcut')
  ]
  return [
    {
      region: 'sidebar' as const,
      targetSectionId: 'appearance-sidebar-zoom',
      title: translate('settings.appearance.zoom.sidebar', 'Sidebar zoom'),
      description: translate(
        'settings.appearance.zoom.sidebarDescription',
        'Scale the bot list, projects, and worktree cards.'
      ),
      keywords
    },
    {
      region: 'panel' as const,
      targetSectionId: 'appearance-panel-zoom',
      title: translate('settings.appearance.zoom.panel', 'Panel zoom'),
      description: translate(
        'settings.appearance.zoom.panelDescription',
        'Scale tabs, terminals, chats, editors, and the right sidebar.'
      ),
      keywords
    }
  ]
})
