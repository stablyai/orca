import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getPreviewProxySearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.PreviewProxySettingsSection.a6d49f6741',
      'Workspace Preview Proxy'
    ),
    description: translate(
      'auto.components.settings.PreviewProxySettingsSection.bfadb61ecf',
      'Expose workspace dev servers through one host-routed listener, so browsers and paired clients open them directly.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.preview.proxy.search.6c17d9b6a2',
        'preview'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.20b711ac9e', 'proxy'),
      ...translateSearchKeyword(
        'auto.components.settings.preview.proxy.search.a1ce90a10a',
        'ports'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.preview.proxy.search.4cf2e3c78e',
        'dev server'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.preview.proxy.search.9d1bb03df1',
        'domain'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.preview.proxy.search.4f0d0b1f6b',
        'wildcard'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.preview.proxy.search.7a5e9e0d92',
        'serve'
      ),
      ...translateSearchKeyword('auto.components.settings.preview.proxy.search.5c1f5f4a1e', 'token')
    ]
  }
])
