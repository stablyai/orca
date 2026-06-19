import { getTerminalClipboardSearchEntries } from './terminal-clipboard-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalPaneAppearanceSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.72bbcbd1dd',
      'Inactive Pane Opacity'
    ),
    description: translate(
      'auto.components.settings.terminal.search.18dd5026c6',
      'Opacity applied to panes that are not currently active.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.46d99ef4bb', 'opacity'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6c4c85ba43', 'dimming')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.2d5ab88b7c', 'Divider Thickness'),
    description: translate(
      'auto.components.settings.terminal.search.e58d4040d0',
      'Thickness of the pane divider line.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.781f49d942', 'divider'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f637a7dee9', 'thickness')
    ]
  }
])

export const getTerminalPaneInteractionSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.ask_before_closing_running_terminals_title',
      'Ask Before Closing Running Terminals'
    ),
    description: translate(
      'auto.components.settings.terminal.search.ask_before_closing_running_terminals_description',
      'Show a confirmation before closing a terminal that has a running command or agent.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.10f9fb6fea', 'settings'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a0c44061ee', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.close_terminal', 'close'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.39ea7c0d28', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.running', 'running'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.command', 'command'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.agent', 'agent'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.process', 'process'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.prompt', 'prompt'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.stop', 'stop')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.c6178a2b4d', 'Focus Follows Mouse'),
    description: translate(
      'auto.components.settings.terminal.search.17cc3ea102',
      "Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting. Selections and window switching stay safe."
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f5d1e3d472', 'focus'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b5116e7b12', 'follows'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.ea364ce6e4', 'mouse'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d1fa00a9cb', 'hover'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.82b63d07fe', 'ghostty'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f036794286', 'active')
    ]
  },
  ...getTerminalClipboardSearchEntries()
])
