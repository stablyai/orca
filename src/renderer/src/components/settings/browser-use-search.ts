import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserUsePaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.browser.use.search.50f0860e18', 'Enable Orca CLI'),
    description: translate(
      'auto.components.settings.browser.use.search.890ddf943d',
      'Register the Orca CLI so agents can drive the browser.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.ba4eb53b72',
        'browser use'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.85fab5e12c', 'cli'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.ff05cbc344', 'orca'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.30c74aaa1f', 'path'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.3ffafc9b95',
        'command'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.7e0dcb257a', 'shell'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.034c5e8d7f', 'enable'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.e56c7b55c9', 'setup')
    ]
  },
  {
    title: translate(
      'auto.components.settings.browser.use.search.a1414dcefb',
      'Install Browser Use Skill'
    ),
    description: translate(
      'auto.components.settings.browser.use.search.a7e82445fa',
      "Install the Browser Use skill so agents can operate Orca's browser."
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.ba4eb53b72',
        'browser use'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.a2d489263e', 'skill'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.9d97446873', 'agent'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.e5a784bc54',
        'install'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.f5b8fdddf5',
        'orca-cli'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.6ea88e5206', 'npx'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.a57c2172dc',
        'agent-browser'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.cee44fb442',
        'automation'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.browser.use.search.614c756ab1',
      'Import Browser Cookies'
    ),
    description: translate(
      'auto.components.settings.browser.use.search.2fb24d17db',
      'Import cookies from Chrome, Edge, or other browsers so agents can reuse your logins.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.ba4eb53b72',
        'browser use'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.fb8178824f',
        'cookies'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.02837ee497',
        'session'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.d5ad1f7aad', 'import'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.48557f639c', 'login'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.96ce3d2de2', 'auth'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.088e7a9012', 'chrome'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.2e1b09897b', 'edge'),
      ...translateSearchKeyword('auto.components.settings.browser.use.search.ab349a2dd0', 'arc'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.20c1323d1e',
        'computer use'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.63a66da648',
        'system browser'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.62e2a790c0',
        'existing session'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.59968bb9b4',
        'authenticated browser'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.22fb801af8',
        'chrome profile'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.d5afa54d21',
        'edge profile'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.use.search.3f4c559deb',
        'arc profile'
      )
    ]
  }
])
