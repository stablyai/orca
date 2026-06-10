import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalDarkThemeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.ec07ce9b02', 'Dark Theme'),
    description: translate(
      'auto.components.settings.terminal.search.13f6310dd3',
      'Choose the terminal theme used in dark mode.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0ce176909a', 'theme'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f785374072', 'dark'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7718d70356', 'preview')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.8987db7ff2', 'Dark Divider Color'),
    description: translate(
      'auto.components.settings.terminal.search.9c32726f47',
      'Controls the split divider line between panes in dark mode.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.781f49d942', 'divider'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f785374072', 'dark'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.674b7c8436', 'color')
    ]
  }
])

export const getTerminalLightThemeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.232e532169',
      'Use Separate Theme In Light Mode'
    ),
    description: translate(
      'auto.components.settings.terminal.search.f268092ee3',
      'When disabled, light mode reuses the dark terminal theme.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.da864e6cec',
        'light mode'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0ce176909a', 'theme')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.1d89457764', 'Light Theme'),
    description: translate(
      'auto.components.settings.terminal.search.1dee533bd9',
      'Choose the theme used when Orca is in light mode.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0ce176909a', 'theme'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.411229c636', 'light'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7718d70356', 'preview')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.595b97b446', 'Light Divider Color'),
    description: translate(
      'auto.components.settings.terminal.search.77d9f9cd55',
      'Controls the split divider line between panes in light mode.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.781f49d942', 'divider'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.411229c636', 'light'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.674b7c8436', 'color')
    ]
  }
])

export const getTerminalYamlImportSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.yaml_import.title',
      'Import from YAML'
    ),
    description: translate(
      'auto.components.settings.terminal.search.yaml_import.description',
      'Import theme YAML files as Orca terminal themes.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.search.yaml_import.keyword_yaml', 'yaml'),
      translate('auto.components.settings.terminal.search.fd752b3cac', 'import'),
      translate('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      translate('auto.components.settings.terminal.search.0ce176909a', 'theme'),
      translate('auto.components.settings.terminal.search.warp_import.keyword_themes', 'themes'),
      translate('auto.components.settings.terminal.search.yaml_import.keyword_custom', 'custom')
    ]
  }
])

export const getTerminalWarpImportSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.warp_import.title',
      'Import themes from Warp'
    ),
    description: translate(
      'auto.components.settings.terminal.search.warp_import.description',
      'Import Warp themes as Orca terminal themes.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.search.warp_import.keyword_warp', 'warp'),
      translate('auto.components.settings.terminal.search.fd752b3cac', 'import'),
      translate('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      translate('auto.components.settings.terminal.search.0ce176909a', 'theme'),
      translate('auto.components.settings.terminal.search.warp_import.keyword_themes', 'themes'),
      translate('auto.components.settings.terminal.search.warp_import.keyword_yaml', 'yaml')
    ]
  }
])
