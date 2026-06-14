import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getSshPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.ssh.search.380a788da7', 'SSH Connections'),
    description: translate('auto.components.settings.ssh.search.74c6d90d78', 'Manage SSH hosts.'),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.d4bcd497c7', 'remote'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.f9493b80c0', 'server'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.237b391f7c', 'connection'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.8fb1cc87cc', 'host')
    ]
  },
  {
    title: translate('auto.components.settings.ssh.search.f5a691bb6c', 'Add SSH Target'),
    description: translate('auto.components.settings.ssh.search.62826efbe9', 'Add a new SSH host.'),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.f7b6383aec', 'add'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.00d1fda01a', 'new'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.09395490af', 'target'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.8fb1cc87cc', 'host'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.f9493b80c0', 'server')
    ]
  },
  {
    title: translate('auto.components.settings.ssh.search.41a3127094', 'Import from SSH Config'),
    description: translate(
      'auto.components.settings.ssh.search.7f251a45a8',
      'Import hosts from ~/.ssh/config.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.3b12e064a4', 'import'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.5220501141', 'config'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.2cd40ba0d0', 'hosts')
    ]
  },
  {
    title: translate('auto.components.settings.ssh.search.a3058f3605', 'Test Connection'),
    description: translate(
      'auto.components.settings.ssh.search.96ca5d9a0b',
      'Test connectivity to an SSH target.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.ssh.search.7efd17e816', 'ssh'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.8cb870b109', 'test'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.237b391f7c', 'connection'),
      ...translateSearchKeyword('auto.components.settings.ssh.search.d41f296f64', 'ping')
    ]
  }
])
