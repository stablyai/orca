import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalTypographySearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.5930244899', 'Font Size'),
    description: translate(
      'auto.components.settings.terminal.search.0fe0073f0c',
      'Default terminal font size for new panes and live updates.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.103cdb862f',
        'typography'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.33031c1465', 'text size')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.e989914ad6', 'Font Family'),
    description: translate(
      'auto.components.settings.terminal.search.0acdc17891',
      'Default terminal font family for new panes and live updates.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.103cdb862f',
        'typography'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b0bb76ae6b', 'font')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.28ea41bd2d', 'Font Weight'),
    description: translate(
      'auto.components.settings.terminal.search.98c18f2c77',
      'Controls the terminal text font weight.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.103cdb862f',
        'typography'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.20ce287cc6', 'weight')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.0f2fb0cb74', 'Line Height'),
    description: translate(
      'auto.components.settings.terminal.search.36a1b38bc8',
      'Controls the terminal line height multiplier.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.103cdb862f',
        'typography'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.7341e3d00e',
        'line height'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b2f52cb96c', 'spacing')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.58da1ae45d', 'Font Ligatures'),
    description: translate(
      'auto.components.settings.terminal.search.893aa92997',
      'Render programming ligatures (e.g. => → ≠ ≥) for fonts that ship them. "Auto" enables ligatures only for known ligature fonts (Fira Code, JetBrains Mono, Cascadia Code, Iosevka, etc.).'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.103cdb862f',
        'typography'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.afc8d5f790', 'ligatures'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7ab424c4d3', 'ligature'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7f7640c29e', 'fira code'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.35c2311a33',
        'jetbrains mono'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.e3aeea308e',
        'cascadia code'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6ded6297fe', 'iosevka'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a16224d16a', 'calt'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.d5e6c7fab1',
        'font features'
      )
    ]
  }
])

export const getTerminalRenderingSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.13a2502dfc', 'GPU Acceleration'),
    description: translate(
      'auto.components.settings.terminal.search.8f9f953de7',
      'Controls whether the terminal uses xterm.js WebGL rendering. Auto tries WebGL when the renderer is supported, with conservative fallback for software or unknown GPU renderers.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.db82cb13b0', 'gpu'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.4b4e80d850',
        'acceleration'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6cddc858ba', 'webgl'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.fffa9ab980', 'renderer'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.bc7ae1f7c0', 'rendering'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7d924d870d', 'graphics'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.1abcf4d7de', 'linux')
    ]
  }
])

export const getTerminalCursorSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.97bcfff662', 'Cursor Shape'),
    description: translate(
      'auto.components.settings.terminal.search.275a9d6395',
      'Default cursor appearance for Orca terminal panes.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6eaf7ee0e4', 'cursor'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.a6e9dcc829', 'bar'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.015c82349f', 'block'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.eefd1d8332', 'underline')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.b03d01fd49', 'Blinking Cursor'),
    description: translate(
      'auto.components.settings.terminal.search.a27f6edf52',
      'Uses the blinking variant of the selected cursor shape.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6eaf7ee0e4', 'cursor'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.25f606d9e5', 'blink')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.7f1e356a54', 'Cursor Opacity'),
    description: translate(
      'auto.components.settings.terminal.search.d4f7d1ce5c',
      'Opacity of the terminal cursor.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6eaf7ee0e4', 'cursor'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.46d99ef4bb', 'opacity'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.4f7f8f28ca',
        'transparency'
      )
    ]
  }
])
