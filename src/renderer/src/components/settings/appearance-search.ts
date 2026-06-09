import type { SettingsSearchEntry } from './settings-search'
import { getTerminalAppearanceSearchEntries } from './terminal-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { SHOW_UI_LANGUAGE_SETTING } from '@/i18n/supported-languages'
import { getStatusBarToggles } from './appearance-status-bar-search'

export { getStatusBarToggles }

export const getThemeEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.71e06350b4', 'Theme'),
    description: translate(
      'auto.components.settings.appearance.search.0709c794f7',
      'Choose how Orca looks in the app window.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.262fe1d24f', 'dark'),
      translate('auto.components.settings.appearance.search.44d873fd18', 'light'),
      translate('auto.components.settings.appearance.search.3a9b69d734', 'system')
    ]
  }
])

export const getLanguageEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.language.title', 'Language'),
    description: translate(
      'settings.appearance.language.description',
      'Choose the language used by the Orca interface.'
    ),
    keywords: [
      translate('settings.appearance.language.title', 'Language'),
      translate(
        'settings.appearance.language.description',
        'Choose the language used by the Orca interface.'
      ),
      translate('settings.appearance.language.system', 'System'),
      translate('settings.appearance.language.english', 'English'),
      translate('auto.components.settings.appearance.search.language.locale', 'locale'),
      translate('auto.components.settings.appearance.search.language.i18n', 'i18n'),
      translate('auto.components.settings.appearance.search.language.translation', 'translation')
    ]
  }
])

export const getZoomEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.c5e933970f', 'UI Zoom'),
    description: translate(
      'auto.components.settings.appearance.search.adddb91a3d',
      'Scale the entire application interface.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.3ae5de6101', 'zoom'),
      translate('auto.components.settings.appearance.search.0952091186', 'scale'),
      translate('auto.components.settings.appearance.search.0c83659f48', 'shortcut')
    ]
  }
])

export const getTypographyEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.ddb991024d', 'IDE Font'),
    description: translate(
      'auto.components.settings.appearance.search.07c7c38fac',
      'Choose the font used by the Orca interface.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.24094af355', 'font'),
      translate('auto.components.settings.appearance.search.a0e09aed9c', 'typeface'),
      translate('auto.components.settings.appearance.search.8b36fb3f64', 'typography'),
      translate('auto.components.settings.appearance.search.fab91464dd', 'ide'),
      translate('auto.components.settings.appearance.search.1f2880a9d5', 'orca'),
      translate('auto.components.settings.appearance.search.5095258df2', 'interface'),
      translate('auto.components.settings.appearance.search.36e006efc1', 'app'),
      translate('auto.components.settings.appearance.search.2f12e1aa3a', 'ui')
    ]
  }
])

export const getLayoutEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.appearance.search.f8129fb544',
      'Show Git-Ignored Files'
    ),
    description: translate(
      'auto.components.settings.appearance.search.7164edf71a',
      'Dim files matched by .gitignore in the file explorer.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.bce3ac317a', 'git'),
      translate('auto.components.settings.appearance.search.08c86bf58e', 'gitignore'),
      translate('auto.components.settings.appearance.search.9f2df826ac', 'ignored'),
      translate('auto.components.settings.appearance.search.c1bca1885a', 'file explorer'),
      translate('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      translate('auto.components.settings.appearance.search.648eeada79', 'hide')
    ]
  }
])

export const getTitlebarEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.fdd31b00d0', 'Titlebar App Name'),
    description: translate(
      'auto.components.settings.appearance.search.18b4c4c30b',
      'Show Orca in the titlebar.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.bed343b03e', 'titlebar'),
      translate('auto.components.settings.appearance.search.1f2880a9d5', 'orca'),
      translate('auto.components.settings.appearance.search.36e006efc1', 'app'),
      translate('auto.components.settings.appearance.search.51f957ce39', 'name'),
      translate('auto.components.settings.appearance.search.a895d0f938', 'brand')
    ]
  }
])

export const getStatusBarEntries = createLocalizedCatalog((): SettingsSearchEntry[] =>
  getStatusBarToggles().map(({ title, description, keywords }) => ({
    title,
    description,
    keywords
  }))
)

export const getSidebarEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.155a1e7438', 'Show Tasks Button'),
    description: translate(
      'auto.components.settings.appearance.search.9a248333c7',
      'Show the Tasks button at the top of the left sidebar.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.0d5a74b606', 'tasks'),
      translate('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      translate('auto.components.settings.appearance.search.6cf5f54ce1', 'button'),
      translate('auto.components.settings.appearance.search.648eeada79', 'hide'),
      translate('auto.components.settings.appearance.search.ac79fe4a04', 'show'),
      translate('auto.components.settings.appearance.search.2ee4810f38', 'github'),
      translate('auto.components.settings.appearance.search.6b846424cc', 'linear')
    ]
  },
  {
    title: translate(
      'auto.components.settings.appearance.search.caa27e1a8e',
      'Show Automations Button'
    ),
    description: translate(
      'auto.components.settings.appearance.search.ae13a0d340',
      'Show the Automations button at the top of the left sidebar.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.b186f3cefb', 'automations'),
      translate('auto.components.settings.appearance.search.58f4e22fa2', 'automation'),
      translate('auto.components.settings.appearance.search.4c920ab2d1', 'schedule'),
      translate('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      translate('auto.components.settings.appearance.search.6cf5f54ce1', 'button'),
      translate('auto.components.settings.appearance.search.648eeada79', 'hide'),
      translate('auto.components.settings.appearance.search.ac79fe4a04', 'show')
    ]
  },
  {
    title: translate(
      'auto.components.settings.appearance.search.1de96ec8a6',
      'Show Orca Mobile Button'
    ),
    description: translate(
      'auto.components.settings.appearance.search.682293cadf',
      'Show the Orca Mobile button at the top of the left sidebar.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.74618577c7', 'mobile'),
      translate('auto.components.settings.appearance.search.5e5b8878bf', 'phone'),
      translate('auto.components.settings.appearance.search.5bff6a2ef0', 'sidebar'),
      translate('auto.components.settings.appearance.search.6cf5f54ce1', 'button'),
      translate('auto.components.settings.appearance.search.648eeada79', 'hide'),
      translate('auto.components.settings.appearance.search.ac79fe4a04', 'show'),
      translate('auto.components.settings.appearance.search.839fb1e3ed', 'toolbox')
    ]
  }
])

export const getAppIconEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.2b313598c6', 'App Icon'),
    description: translate(
      'auto.components.settings.appearance.search.e80c2af428',
      'Choose the app icon shown in the Dock and window switcher.'
    ),
    keywords: [
      translate('auto.components.settings.appearance.search.2cfb3420c0', 'app icon'),
      translate('auto.components.settings.appearance.search.1f2880a9d5', 'orca'),
      translate('auto.components.settings.appearance.search.d18b54ca90', 'dock'),
      translate('auto.components.settings.appearance.search.e5bc35d59e', 'window'),
      translate('auto.components.settings.appearance.search.651f35b2c6', 'switcher'),
      translate('auto.components.settings.appearance.search.f586abfa35', 'blue'),
      translate('auto.components.settings.appearance.search.468448bba4', 'watercolor')
    ]
  }
])

export const getAppearancePaneSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  ...getThemeEntries(),
  ...(SHOW_UI_LANGUAGE_SETTING ? getLanguageEntries() : []),
  ...getTypographyEntries(),
  ...getZoomEntries(),
  ...getTerminalAppearanceSearchEntries(),
  ...getLayoutEntries(),
  ...getTitlebarEntries(),
  ...getStatusBarEntries(),
  ...getSidebarEntries(),
  ...getAppIconEntries()
])
