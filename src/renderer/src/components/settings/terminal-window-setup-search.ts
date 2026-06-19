import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getManageSessionsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.6f5d486a68', 'Manage Sessions'),
    description: translate(
      'auto.components.settings.terminal.search.f72abc493c',
      'Recover from frozen terminals by killing sessions, clearing saved scrollback, or restarting the daemon.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f35400f7e8', 'daemon'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.9f2dda133c', 'pty'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d802a578bf', 'sessions'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a8d2784214', 'manage'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a3e5297c10', 'kill'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.920573d65b', 'kill all'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.456da64d4d', 'clear'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.3982d88725', 'history'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.cde233f5da',
        'scrollback'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6892fb1019', 'restart'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0a05629060', 'recover'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.88561b3499', 'frozen'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d4daf4f612', 'unfreeze')
    ]
  }
])

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
    title: translate('auto.components.settings.terminal.search.72d0482137', 'Window Blur'),
    description: translate(
      'auto.components.settings.terminal.search.bc2054657a',
      'Apply background blur to the terminal window. Requires restart.'
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
      ...translateSearchKeyword('auto.components.settings.terminal.search.6c2f9f05c8', 'vibrancy')
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

export const getTerminalSetupScriptSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.5be2d67678',
      'Setup Script Location'
    ),
    description: translate(
      'auto.components.settings.terminal.search.2610ee3b56',
      "Where the repository setup script runs when a new workspace is created: a vertical split (default), a horizontal split, or a background tab titled 'Setup'."
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.4529806908', 'setup'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6b659fff2a', 'script'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7a48c7715b', 'workspace'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.de7bc1d5f5', 'split'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.54a9b3725b',
        'horizontal'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.18ce996647', 'vertical'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f44643328e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.fd6c24313d', 'new'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b872de3926', 'location'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.c047f398cc', 'launch')
    ]
  }
])
