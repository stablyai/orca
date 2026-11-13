import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalWindowSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.9b41f4be64', 'Background opacity'),
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
    title: translate('settings.windowMaterial.fc2ba9b528', 'Window material'),
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
    title: translate('auto.components.settings.terminal.search.cfdaed8dae', 'Horizontal padding'),
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
    title: translate('auto.components.settings.terminal.search.3fdccf0277', 'Vertical padding'),
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
      'auto.components.settings.terminal.search.9d81f938fd',
      'Hide mouse while typing'
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
    title: translate('auto.components.settings.terminal.search.a5e5d2bca5', 'Color overrides'),
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

export const getTerminalShellCommandWrapperSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.shellCommandWrapperTitle',
      'Command Wrapper'
    ),
    description: translate(
      'auto.components.settings.terminal.search.shellCommandWrapperDescription',
      'Optional template that wraps agent and terminal launch commands (for example devenv shell -- $CMD).'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.shellKw', 'shell'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.wrapperKw', 'wrapper'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.commandKw', 'command'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.devenvKw', 'devenv'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.nixKw', 'nix'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.environmentKw',
        'environment'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.agentKw', 'agent'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.cmdKw', '$CMD'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.launchKw2', 'launch')
    ]
  }
])
