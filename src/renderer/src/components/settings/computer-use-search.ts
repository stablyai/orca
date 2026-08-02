import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getComputerUsePaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.computer.use.search.442bec10fe', 'Computer Use'),
    description: translate(
      'auto.components.settings.computer.use.search.9210db582b',
      'Allow agents to inspect screenshots and operate local apps when you ask.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.computer.use.search.fefb452f5b',
        'computer use'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.computer.use.search.82f01c2d2c',
        'accessibility'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.computer.use.search.26c1290d83',
        'screen recording'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.computer.use.search.e27f8bafbf',
        'screenshot'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.computer.use.search.798be54d7e',
        'automation'
      ),
      ...translateSearchKeyword('auto.components.settings.computer.use.search.6e88da3508', 'skill')
    ]
  }
])
