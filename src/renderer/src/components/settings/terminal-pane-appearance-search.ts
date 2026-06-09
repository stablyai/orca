import { getTerminalClipboardSearchEntries } from './terminal-clipboard-search'
import { translate } from '@/i18n/i18n'
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
      translate('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      translate('auto.components.settings.terminal.search.46d99ef4bb', 'opacity'),
      translate('auto.components.settings.terminal.search.6c4c85ba43', 'dimming')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.2d5ab88b7c', 'Divider Thickness'),
    description: translate(
      'auto.components.settings.terminal.search.e58d4040d0',
      'Thickness of the pane divider line.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      translate('auto.components.settings.terminal.search.781f49d942', 'divider'),
      translate('auto.components.settings.terminal.search.f637a7dee9', 'thickness')
    ]
  }
])

export const getTerminalPaneInteractionSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.c6178a2b4d', 'Focus Follows Mouse'),
    description: translate(
      'auto.components.settings.terminal.search.17cc3ea102',
      "Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting. Selections and window switching stay safe."
    ),
    keywords: [
      translate('auto.components.settings.terminal.search.f5d1e3d472', 'focus'),
      translate('auto.components.settings.terminal.search.b5116e7b12', 'follows'),
      translate('auto.components.settings.terminal.search.ea364ce6e4', 'mouse'),
      translate('auto.components.settings.terminal.search.d1fa00a9cb', 'hover'),
      translate('auto.components.settings.terminal.search.846a7a1204', 'pane'),
      translate('auto.components.settings.terminal.search.82b63d07fe', 'ghostty'),
      translate('auto.components.settings.terminal.search.f036794286', 'active')
    ]
  },
  ...getTerminalClipboardSearchEntries()
])
