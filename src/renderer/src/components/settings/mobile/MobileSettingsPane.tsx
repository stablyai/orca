import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { MobilePane } from './MobilePane'
import {
  getMobileOverviewSearchEntry,
  getMobileSidebarShortcutSearchEntry
} from './mobile-settings-search'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { MobileRelayBetaNotice } from '../../mobile/pairing/MobileRelayBetaNotice'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

const ORCA_IOS_APP_STORE_URL = 'https://apps.apple.com/app/orca-ide/id6766130217'
const ORCA_ANDROID_APK_URL = 'https://orca.dev/download/android'

export function MobileSettingsPane(): React.JSX.Element {
  const t = useTranslate()
  const showMobileButton = useAppStore((s) => s.settings?.showMobileButton !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="space-y-8">
      <SettingsGroup>
        <SearchableSetting
          title={t('auto.components.settings.MobileSettingsPane.e7a3ae8c4e', 'Mobile')}
          description={t(
            'auto.components.settings.MobileSettingsPane.174f4a3c6d',
            'Control terminals and agents from your phone.'
          )}
          keywords={getMobileOverviewSearchEntry().keywords}
          className="py-3"
        >
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              {t(
                'auto.components.settings.MobileSettingsPane.installIntro',
                'Install Orca Mobile from the'
              )}{' '}
              <button
                type="button"
                onClick={(event) => openAppHttpLink(ORCA_IOS_APP_STORE_URL, { event })}
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              >
                {t('auto.components.settings.MobileSettingsPane.b5a2ed83ff', 'App Store')}
              </button>
              {' · '}
              <button
                type="button"
                // Link the pinned release APK until Android distribution moves to Google Play.
                onClick={(event) => openAppHttpLink(ORCA_ANDROID_APK_URL, { event })}
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              >
                {t('auto.components.settings.MobileSettingsPane.androidApkLabel', 'Android APK')}
              </button>
              {t('auto.components.settings.MobileSettingsPane.installOutro', ', then pair below.')}
            </p>
            <MobileRelayBetaNotice />
          </div>
        </SearchableSetting>

        <SearchableSetting
          title={t(
            'auto.components.settings.MobileSettingsPane.49089c92b3',
            'Show Orca Mobile button'
          )}
          description={t(
            'auto.components.settings.MobileSettingsPane.682293cadf',
            'Show the Orca Mobile button at the top of the left sidebar.'
          )}
          keywords={getMobileSidebarShortcutSearchEntry().keywords}
        >
          {/* Why: the in-page removal toast points users to Settings > Mobile. */}
          <SettingsSwitchRow
            label={t(
              'auto.components.settings.MobileSettingsPane.49089c92b3',
              'Show Orca Mobile button'
            )}
            description={t(
              'auto.components.settings.MobileSettingsPane.d4f2b65f30',
              'Show the Orca Mobile shortcut in the sidebar.'
            )}
            checked={showMobileButton}
            onChange={() => updateSettings({ showMobileButton: !showMobileButton })}
          />
        </SearchableSetting>
      </SettingsGroup>

      <SettingsGroup>
        <MobilePane />
      </SettingsGroup>
    </div>
  )
}
