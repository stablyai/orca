import type { StatusBarItem } from '../../../../shared/types'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getStatusBarToggles = createLocalizedCatalog(
  (): readonly {
    id: StatusBarItem
    title: string
    description: string
    keywords: string[]
    toggleDescription: string
  }[] => [
    {
      id: 'claude',
      title: translate('auto.components.settings.appearance.search.9dc15020d7', 'Claude Usage'),
      description: translate(
        'auto.components.settings.appearance.search.de50c6f516',
        'Show Claude token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.c9fe3a7876',
          'claude'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.dea0a9a665',
          'anthropic'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.claudeToggleDescription',
        'Show Claude token and cost usage for the active workspace.'
      )
    },
    {
      id: 'codex',
      title: translate('auto.components.settings.appearance.search.54b1acf24f', 'Codex Usage'),
      description: translate(
        'auto.components.settings.appearance.search.e9e4412545',
        'Show Codex token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.8dfd676c28', 'codex'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.97957e374e', 'openai')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.codexToggleDescription',
        'Show Codex token and cost usage for the active workspace.'
      )
    },
    {
      id: 'gemini',
      title: translate('auto.components.settings.appearance.search.5bfb874d05', 'Gemini Usage'),
      description: translate(
        'auto.components.settings.appearance.search.9660c5b2f1',
        'Show Gemini token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.2804a920ad',
          'gemini'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.51b0ccd6a2', 'google')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.geminiToggleDescription',
        'Show Gemini token and cost usage for the active workspace.'
      )
    },
    {
      id: 'opencode-go',
      title: translate(
        'auto.components.settings.appearance.search.bc046e7899',
        'OpenCode Go Usage'
      ),
      description: translate(
        'auto.components.settings.appearance.search.7f72de7cbe',
        'Show OpenCode Go token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.a9d56852eb',
          'opencode'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.d77537b580',
          'opencode-go'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.opencodeGoToggleDescription',
        'Show OpenCode Go token and cost usage for the active workspace.'
      )
    },
    {
      id: 'kimi',
      title: translate('auto.components.settings.appearance.search.3a6c028ea8', 'Kimi Usage'),
      description: translate(
        'auto.components.settings.appearance.search.c927a155d5',
        'Show Kimi subscription usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.40e5c3c285', 'kimi'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.de586def95',
          'subscription'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.35565867cb',
          'moonshot'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.kimiToggleDescription',
        'Show Kimi subscription usage for the active workspace.'
      )
    },
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
