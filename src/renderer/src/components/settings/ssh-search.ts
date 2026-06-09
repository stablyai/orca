import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getSshPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.ssh.search.380a788da7', 'SSH Connections'),
    description: translate(
      'auto.components.settings.ssh.search.74c6d90d78',
      'Manage remote SSH targets.'
    ),
    keywords: [
      translate('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      translate('auto.components.settings.ssh.search.d4bcd497c7', 'remote'),
      translate('auto.components.settings.ssh.search.f9493b80c0', 'server'),
      translate('auto.components.settings.ssh.search.237b391f7c', 'connection'),
      translate('auto.components.settings.ssh.search.8fb1cc87cc', 'host')
    ]
  },
  {
    title: translate('auto.components.settings.ssh.search.f5a691bb6c', 'Add SSH Target'),
    description: translate(
      'auto.components.settings.ssh.search.62826efbe9',
      'Add a new remote SSH target.'
    ),
    keywords: [
      translate('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      translate('auto.components.settings.ssh.search.f7b6383aec', 'add'),
      translate('auto.components.settings.ssh.search.00d1fda01a', 'new'),
      translate('auto.components.settings.ssh.search.09395490af', 'target'),
      translate('auto.components.settings.ssh.search.8fb1cc87cc', 'host'),
      translate('auto.components.settings.ssh.search.f9493b80c0', 'server')
    ]
  },
  {
    title: translate('auto.components.settings.ssh.search.41a3127094', 'Import from SSH Config'),
    description: translate(
      'auto.components.settings.ssh.search.7f251a45a8',
      'Import hosts from ~/.ssh/config.'
    ),
    keywords: [
      translate('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      translate('auto.components.settings.ssh.search.3b12e064a4', 'import'),
      translate('auto.components.settings.ssh.search.5220501141', 'config'),
      translate('auto.components.settings.ssh.search.2cd40ba0d0', 'hosts')
    ]
  },
  {
    title: translate('auto.components.settings.ssh.search.a3058f3605', 'Test Connection'),
    description: translate(
      'auto.components.settings.ssh.search.96ca5d9a0b',
      'Test connectivity to an SSH target.'
    ),
    keywords: [
      translate('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      translate('auto.components.settings.ssh.search.8cb870b109', 'test'),
      translate('auto.components.settings.ssh.search.237b391f7c', 'connection'),
      translate('auto.components.settings.ssh.search.d41f296f64', 'ping')
    ]
  }
])
