import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalClipboardSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.clipboard.search.3bdc84f059',
      'Copy on Select'
    ),
    description: translate(
      'auto.components.settings.terminal.clipboard.search.603818e8d8',
      'Automatically copy terminal selections to the clipboard as soon as a selection is made.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.clipboard.search.10d73e22d3', 'clipboard'),
      translate('auto.components.settings.terminal.clipboard.search.a38508c419', 'copy'),
      translate('auto.components.settings.terminal.clipboard.search.797fdfe4ca', 'select'),
      translate('auto.components.settings.terminal.clipboard.search.c38c18be15', 'selection'),
      translate('auto.components.settings.terminal.clipboard.search.664789b73a', 'auto'),
      translate('auto.components.settings.terminal.clipboard.search.e87c6d776d', 'automatic'),
      translate('auto.components.settings.terminal.clipboard.search.737cef6de1', 'x11'),
      translate('auto.components.settings.terminal.clipboard.search.cf83ac3dbd', 'linux'),
      translate('auto.components.settings.terminal.clipboard.search.4043e294d2', 'gnome'),
      translate('auto.components.settings.terminal.clipboard.search.5fb3512e8c', 'paste')
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.clipboard.search.74db8721e4',
      'Allow TUI Clipboard Writes (OSC 52)'
    ),
    description: translate(
      'auto.components.settings.terminal.clipboard.search.459fea094a',
      'Let programs in the terminal copy to the system clipboard through OSC 52, including over SSH.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.clipboard.search.62d1208b90', 'osc 52'),
      translate('auto.components.settings.terminal.clipboard.search.9dfc125cd3', 'osc52'),
      translate('auto.components.settings.terminal.clipboard.search.10d73e22d3', 'clipboard'),
      translate('auto.components.settings.terminal.clipboard.search.5ffcd13c90', 'tmux'),
      translate('auto.components.settings.terminal.clipboard.search.2061d8db1a', 'neovim'),
      translate('auto.components.settings.terminal.clipboard.search.64533e30cc', 'nvim'),
      translate('auto.components.settings.terminal.clipboard.search.9fda309db9', 'fzf'),
      translate('auto.components.settings.terminal.clipboard.search.043b32faa1', 'ssh'),
      translate('auto.components.settings.terminal.clipboard.search.d106f44fb4', 'remote'),
      translate('auto.components.settings.terminal.clipboard.search.a38508c419', 'copy'),
      translate('auto.components.settings.terminal.clipboard.search.5fb3512e8c', 'paste')
    ]
  }
])
