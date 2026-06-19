// Settings-search entries for the Privacy pane. Kept in its own file to
// mirror the other per-pane search modules (notifications-search.ts,
// terminal-search.ts, etc.) and keep Settings.tsx imports uniform.

import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getPrivacyPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.privacy.search.5c508bad41', 'Privacy & Telemetry'),
    description: translate(
      'auto.components.settings.privacy.search.aa3b794c17',
      'Anonymous product usage data, diagnostics, and telemetry controls.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.privacy.search.10124159f1', 'privacy'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.77d3180def', 'telemetry'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.4104f6f0f3', 'analytics'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.79c319948b', 'usage'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.b021b9cb81', 'anonymous'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.3922051573', 'data'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.2b5a5c312f', 'posthog'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.27a27b2f63', 'opt out'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.4d4bb76bf4', 'opt in')
    ]
  },
  {
    title: translate(
      'auto.components.settings.privacy.search.57b283461a',
      'Share Anonymous Usage Data'
    ),
    description: translate(
      'auto.components.settings.privacy.search.b707cc3981',
      'Help improve Orca by sending anonymous feature-usage events.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.privacy.search.77d3180def', 'telemetry'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.79c319948b', 'usage'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.b021b9cb81', 'anonymous'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.4d4bb76bf4', 'opt in'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.27a27b2f63', 'opt out'),
      ...translateSearchKeyword('auto.components.settings.privacy.search.ead1deded2', 'share')
    ]
  },
  {
    title: translate('auto.components.settings.privacy.search.6d258d2ed6', 'Diagnostics'),
    description: translate(
      'auto.components.settings.privacy.search.8b08f32366',
      'App diagnostics and support sharing controls.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.privacy.search.c0494ff48a',
        'diagnostics'
      ),
      ...translateSearchKeyword('auto.components.settings.privacy.search.1686c07fee', 'support')
    ]
  },
  {
    title: translate(
      'auto.components.settings.privacy.search.e058a3c98d',
      'Telemetry environment variables'
    ),
    description: translate(
      'auto.components.settings.privacy.search.f7a2d9f137',
      'Environment variables that disable telemetry transmission.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.privacy.search.83a6cd79b3',
        'do not track'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.privacy.search.058550f6bc',
        'do_not_track'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.privacy.search.69637f4dc4',
        'orca_telemetry_disabled'
      ),
      ...translateSearchKeyword('auto.components.settings.privacy.search.5854a5c752', 'ci'),
      ...translateSearchKeyword(
        'auto.components.settings.privacy.search.664f1a8984',
        'continuous integration'
      ),
      ...translateSearchKeyword('auto.components.settings.privacy.search.94e04427f6', 'env'),
      ...translateSearchKeyword(
        'auto.components.settings.privacy.search.d8191ae5ca',
        'environment variable'
      ),
      ...translateSearchKeyword('auto.components.settings.privacy.search.e8bc614a18', 'disable')
    ]
  }
])
