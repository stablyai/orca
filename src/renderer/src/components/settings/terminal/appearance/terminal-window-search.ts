import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalWindowSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.b36fd2416d', 'Background Opacity'),
    description: translate(
      'auto.components.settings.terminal.search.4c643695aa',
      'Controls the transparency of the terminal background.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.46d99ef4bb', 'opacity'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.4f7f8f28ca',
        'transparency'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.f6dd9ff606',
        'background'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7db59c4738', 'alpha')
    ]
  },
  {
    title: translate('settings.windowMaterial.title', 'Window Material'),
    description: translate(
      'settings.windowMaterial.description',
      'What shows behind translucent terminals. Requires restart.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.0838b3717b', 'window'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.71eb45e293', 'blur'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.f6dd9ff606',
        'background'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.4f7f8f28ca',
        'transparency'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6c2f9f05c8', 'vibrancy'),
      ...translateSearchKeyword('settings.windowMaterial.keywords.acrylic', 'acrylic')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.b4f182f24d', 'Horizontal Padding'),
    description: translate(
      'auto.components.settings.terminal.search.75691e4911',
      'Horizontal padding around the terminal grid in pixels.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.e8baf0d12c', 'padding'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.54a9b3725b',
        'horizontal'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b2f52cb96c', 'spacing'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f25d948664', 'margin')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.692c4ad032', 'Vertical Padding'),
    description: translate(
      'auto.components.settings.terminal.search.4655567c37',
      'Vertical padding around the terminal grid in pixels.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.e8baf0d12c', 'padding'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.18ce996647', 'vertical'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b2f52cb96c', 'spacing'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f25d948664', 'margin')
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.search.d1fe5f99ff',
      'Hide Mouse While Typing'
    ),
    description: translate(
      'auto.components.settings.terminal.search.77201c0bb2',
      'Hide the mouse cursor when typing in the terminal.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.ea364ce6e4', 'mouse'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.ee611ae238', 'hide'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.34fe1af39d', 'typing'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6eaf7ee0e4', 'cursor')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.aed2a4b4eb', 'Color Overrides'),
    description: translate(
      'auto.components.settings.terminal.search.3023e01415',
      'Override individual terminal colors.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.674b7c8436', 'color'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d8bd6182b8', 'override'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.11fd3fbcf2', 'ansi'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.4ba8623632', 'palette'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0ce176909a', 'theme')
    ]
  }
])
