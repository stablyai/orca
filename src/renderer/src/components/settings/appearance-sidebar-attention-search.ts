import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

function getAttentionKeywords(): string[] {
  return [
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.sidebarAttention.attention',
      'attention'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.sidebarAttention.waiting',
      'waiting'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.sidebarAttention.blocked',
      'blocked'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.sidebarAttention.workspace',
      'workspace'
    ),
    ...translateSearchKeyword('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar')
  ]
}

export const getShowNeedsAttentionSectionEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.appearance.search.showNeedsAttentionSection.title',
      'Show a "Needs you" section'
    ),
    description: translate(
      'auto.components.settings.appearance.search.showNeedsAttentionSection.description',
      'Workspaces whose agent is waiting on you also appear in a section at the top of the sidebar.'
    ),
    keywords: [
      ...getAttentionKeywords(),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showNeedsAttentionSection.section',
        'section'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.showNeedsAttentionSection.permission',
        'permission'
      )
    ]
  })
)

export const getHighlightWorkspacesNeedingAttentionEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.appearance.search.highlightWorkspacesNeedingAttention.title',
      'Highlight workspaces that need you'
    ),
    description: translate(
      'auto.components.settings.appearance.search.highlightWorkspacesNeedingAttention.description',
      'Tint workspace rows: amber when an agent is waiting on you, green when it finished and you have not looked, red when it failed.'
    ),
    keywords: [
      ...getAttentionKeywords(),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.highlightWorkspacesNeedingAttention.color',
        'color'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.highlightWorkspacesNeedingAttention.highlight',
        'highlight'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.highlightWorkspacesNeedingAttention.unread',
        'unread'
      )
    ]
  })
)
