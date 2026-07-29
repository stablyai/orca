import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getCodexMicroSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.codexMicro.search.title', 'Codex Micro'),
    description: translate(
      'auto.components.settings.codexMicro.search.description',
      'Connect Codex Micro, customize mappings, lighting, brightness, dial behavior, and firmware status.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.codexMicro.search.codexMicro',
        'codex micro'
      ),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.hardware', 'hardware'),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.lighting', 'lighting'),
      ...translateSearchKeyword(
        'auto.components.settings.codexMicro.search.brightness',
        'brightness'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.codexMicro.search.idleTimeout',
        'idle timeout'
      ),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.dial', 'dial'),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.encoder', 'encoder'),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.mapping', 'mapping'),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.firmware', 'firmware'),
      ...translateSearchKeyword('auto.components.settings.codexMicro.search.usb', 'usb')
    ]
  }
])
