import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import {
  getUsageStatusBarToggles,
  type StatusBarToggleSearchEntry
} from './appearance-status-bar-usage-toggles'

export const getStatusBarToggles = createLocalizedCatalog(
  (): readonly StatusBarToggleSearchEntry[] => [
    ...getUsageStatusBarToggles(),
    {
      id: 'ssh',
      title: translate('auto.components.settings.appearance.search.57fb424c56', 'Remote Hosts'),
      description: translate(
        'auto.components.settings.appearance.search.f17d66d0d2',
        'Show remote host connection status in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.6ecad74eb3', 'ssh'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.a278406ed5',
          'remote'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.f4997e0f8a',
          'connection'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.fe192b060e', 'host')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.sshToggleDescription',
        'Show configured SSH and remote Orca hosts when any are available.'
      )
    },
    {
      id: 'resource-usage',
      title: translate('auto.components.settings.appearance.search.7cf005b29f', 'Resource Manager'),
      description: translate(
        'auto.components.settings.appearance.search.81ef5abc2f',
        'Show CPU, memory, terminal sessions, and workspace disk usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.c690a15849',
          'resource'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.9c4d5f0894',
          'manager'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.4355f18ac6',
          'memory'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.4ddbde4999', 'cpu'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.96b4fb0064',
          'terminal'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.90bdc043ea', 'disk'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.cb1cc62cf8', 'space')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.resourceUsageToggleDescription',
        'Show the Resource Manager. Click it for CPU, memory, sessions, daemon controls, and workspace disk scans.'
      )
    },
    {
      id: 'ports',
      title: translate('auto.components.settings.appearance.search.cf409b6c4d', 'Ports'),
      description: translate(
        'auto.components.settings.appearance.search.0ececfa190',
        'Show live workspace ports in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.006e67b279', 'ports'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.46d21eef62',
          'localhost'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.43cfba3b95',
          'server'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.dc02c8759d',
          'workspace'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.portsToggleDescription',
        'Show live workspace ports. Click it for workspace-scoped ports and external listeners.'
      )
    }
  ]
)
