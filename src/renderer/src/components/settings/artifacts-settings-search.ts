import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getArtifactsSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.artifacts.showButton', 'Show Artifacts Button'),
    description: translate(
      'auto.components.settings.artifacts.showButtonDescription',
      'Show the Artifacts shortcut in the sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.artifacts.keywordArtifacts', 'artifacts'),
      ...translateSearchKeyword('auto.components.settings.artifacts.keywordShare', 'share'),
      ...translateSearchKeyword('auto.components.settings.artifacts.keywordHtml', 'HTML'),
      ...translateSearchKeyword('auto.components.settings.artifacts.keywordMarkdown', 'Markdown'),
      ...translateSearchKeyword('auto.components.settings.artifacts.keywordUpload', 'upload')
    ]
  }
])
