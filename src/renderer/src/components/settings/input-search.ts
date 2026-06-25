import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getInputPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.input.search.d952ce9b46',
      'Middle-click Paste from Selection'
    ),
    description: translate(
      'auto.components.settings.input.search.874d88f4a6',
      'Enabled by default on Linux and macOS. Linux uses the system selection clipboard; other platforms use a private buffer.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.input.search.b51d47ceb7', 'input'),
      ...translateSearchKeyword('auto.components.settings.input.search.e25165320e', 'editing'),
      ...translateSearchKeyword('auto.components.settings.input.search.e5cd0e7a46', 'selection'),
      ...translateSearchKeyword(
        'auto.components.settings.input.search.de51e18ee9',
        'primary selection'
      ),
      ...translateSearchKeyword('auto.components.settings.input.search.31ba58c8ae', 'middle click'),
      ...translateSearchKeyword('auto.components.settings.input.search.5fb84ba77f', 'middle mouse'),
      ...translateSearchKeyword('auto.components.settings.input.search.c4440c3986', 'paste'),
      ...translateSearchKeyword('auto.components.settings.input.search.7059cfb00a', 'clipboard'),
      ...translateSearchKeyword('auto.components.settings.input.search.71905435dd', 'x11'),
      ...translateSearchKeyword('auto.components.settings.input.search.26c83b06c5', 'linux'),
      ...translateSearchKeyword('auto.components.settings.input.search.886597d6b3', 'macos')
    ]
  }
])
