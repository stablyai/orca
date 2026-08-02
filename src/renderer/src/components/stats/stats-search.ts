import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getStatsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.stats.stats.search.cb2430ae6a', 'Stats & Usage'),
    description: translate(
      'auto.components.stats.stats.search.26bb901fcd',
      'Orca stats plus Claude, Codex, OpenCode token analytics and Grok subscription usage.'
    ),
    keywords: [
      translate('auto.components.stats.stats.search.372debfac0', 'stats'),
      translate('auto.components.stats.stats.search.0e2a0b6431', 'usage'),
      translate('auto.components.stats.stats.search.0bba8ca244', 'statistics'),
      translate('auto.components.stats.stats.search.ce8533f02e', 'agents'),
      translate('auto.components.stats.stats.search.ef8bbf7739', 'prs'),
      translate('auto.components.stats.stats.search.5acbe1fdf2', 'time'),
      translate('auto.components.stats.stats.search.8efeae0b22', 'tracking'),
      translate('auto.components.stats.stats.search.e9dc37d889', 'claude'),
      translate('auto.components.stats.stats.search.b77826fca3', 'codex'),
      translate('auto.components.stats.stats.search.6953af58e6', 'opencode'),
      translate('auto.components.stats.stats.search.eaf251e183', 'tokens'),
      translate('auto.components.stats.stats.search.cb6a9f0334', 'cache'),
      translate('auto.components.stats.stats.search.f8a1b2c3d4', 'grok'),
      translate('auto.components.stats.stats.search.e7f0a1b2c3', 'subscription'),
      translate('auto.components.stats.stats.search.d6e9f0a1b2', 'credits'),
      translate('auto.components.stats.stats.search.a3b6c7d8e9', 'grok usage'),
      translate('auto.components.stats.stats.search.9f2a3b4c5d', 'xai')
    ]
  }
])
