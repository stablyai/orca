import { SearchableSetting } from './SearchableSetting'
import { MobilePane } from './MobilePane'
import {
  getMobileOverviewSearchEntry,
  getMobileSettingsPaneSearchEntries
} from './mobile-settings-search'
import { translate } from '@/i18n/i18n'
export { getMobileSettingsPaneSearchEntries }

const ORCA_IOS_APP_STORE_URL = 'https://apps.apple.com/app/orca-ide/id6766130217'
const ORCA_ANDROID_APK_URL =
  'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.15/app-release.apk'

export function MobileSettingsPane(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <SearchableSetting
        title={translate('auto.components.settings.MobileSettingsPane.e7a3ae8c4e', 'Mobile')}
        description={translate(
          'auto.components.settings.MobileSettingsPane.174f4a3c6d',
          'Control terminals and agents from your phone.'
        )}
        keywords={getMobileOverviewSearchEntry().keywords}
        className="space-y-3 py-2"
      >
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.MobileSettingsPane.c8491c17ef',
            'Control Orca from your phone by scanning a QR code. Get the iOS app from the'
          )}{' '}
          <button
            type="button"
            onClick={() => void window.api.shell.openUrl(ORCA_IOS_APP_STORE_URL)}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            {translate('auto.components.settings.MobileSettingsPane.b5a2ed83ff', 'App Store')}
          </button>{' '}
          {translate(
            'auto.components.settings.MobileSettingsPane.b0088412a1',
            'or the Android APK from'
          )}{' '}
          <button
            type="button"
            // Why: Android is moving to Google Play soon, but until then
            // link directly to the pinned APK asset for the current mobile release.
            onClick={() => void window.api.shell.openUrl(ORCA_ANDROID_APK_URL)}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            {translate('auto.components.settings.MobileSettingsPane.9a3c280e49', 'GitHub Releases')}
          </button>
          .
        </p>
      </SearchableSetting>

      <div className="rounded-xl border border-border/60 bg-card/50 p-4">
        <MobilePane />
      </div>
    </div>
  )
}
