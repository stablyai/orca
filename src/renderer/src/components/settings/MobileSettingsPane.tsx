import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { MobilePane } from './MobilePane'
import {
  getMobileEnableSearchEntry,
  getMobileSettingsPaneSearchEntries
} from './mobile-settings-search'
import { translate } from '@/i18n/i18n'
export { getMobileSettingsPaneSearchEntries }

const ORCA_IOS_APP_STORE_URL = 'https://apps.apple.com/app/orca-ide/id6766130217'
const ORCA_ANDROID_APK_URL =
  'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.14/app-release.apk'

type MobileSettingsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function MobileSettingsPane({
  settings,
  updateSettings
}: MobileSettingsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showEnableSetting =
    !settings.experimentalMobile ||
    matchesSettingsSearch(searchQuery, [getMobileEnableSearchEntry()])

  return (
    <div className="space-y-4">
      {showEnableSetting ? (
        <SearchableSetting
          title={translate('auto.components.settings.MobileSettingsPane.e7a3ae8c4e', 'Mobile')}
          description={translate(
            'auto.components.settings.MobileSettingsPane.174f4a3c6d',
            'Control terminals and agents from your phone.'
          )}
          keywords={getMobileEnableSearchEntry().keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>
                {translate('auto.components.settings.MobileSettingsPane.e7a3ae8c4e', 'Mobile')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileSettingsPane.c8491c17ef',
                  'Control Orca from your phone by scanning a QR code. Beta / early preview - expect bugs and breaking changes. Get the iOS app from the'
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
                  {translate(
                    'auto.components.settings.MobileSettingsPane.9a3c280e49',
                    'GitHub Releases'
                  )}
                </button>
                .
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalMobile}
              onClick={() => {
                const nextEnabled = !settings.experimentalMobile
                if (nextEnabled) {
                  useAppStore.getState().recordFeatureInteraction('mobile-pairing')
                }
                updateSettings({
                  experimentalMobile: nextEnabled
                })
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalMobile ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalMobile ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {settings.experimentalMobile ? (
        <div className="rounded-xl border border-border/60 bg-card/50 p-4">
          <MobilePane />
        </div>
      ) : null}
    </div>
  )
}
