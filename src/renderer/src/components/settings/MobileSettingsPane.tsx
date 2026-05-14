import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'
import { MobilePane, MOBILE_PANE_SEARCH_ENTRIES } from './MobilePane'

const ORCA_IOS_APP_STORE_URL = 'https://apps.apple.com/app/orca-ide/id6766130217'
const ORCA_ANDROID_RELEASE_URL = 'https://github.com/stablyai/orca/releases/tag/mobile-v0.0.7'

const MOBILE_ENABLE_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Mobile',
  description: 'Control terminals and agents from your phone.',
  keywords: [
    'mobile',
    'phone',
    'pair',
    'qr',
    'code',
    'scan',
    'remote',
    'android',
    'apk',
    'beta',
    'experimental'
  ]
}

export const MOBILE_SETTINGS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  MOBILE_ENABLE_SEARCH_ENTRY,
  ...MOBILE_PANE_SEARCH_ENTRIES
]

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
    !settings.experimentalMobile || matchesSettingsSearch(searchQuery, [MOBILE_ENABLE_SEARCH_ENTRY])

  return (
    <div className="space-y-4">
      {showEnableSetting ? (
        <SearchableSetting
          title="Mobile"
          description="Control terminals and agents from your phone."
          keywords={MOBILE_ENABLE_SEARCH_ENTRY.keywords}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>Mobile</Label>
              <p className="text-xs text-muted-foreground">
                Control Orca from your phone by scanning a QR code. Beta / early preview &mdash;
                expect bugs and breaking changes. Get the iOS app from the{' '}
                <button
                  type="button"
                  onClick={() => void window.api.shell.openUrl(ORCA_IOS_APP_STORE_URL)}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  App Store
                </button>{' '}
                or the Android APK from{' '}
                <button
                  type="button"
                  // Why: Android is moving to Google Play soon, but until then
                  // link directly to the current mobile release tag instead of
                  // the noisy desktop-dominated releases index.
                  onClick={() => void window.api.shell.openUrl(ORCA_ANDROID_RELEASE_URL)}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  GitHub Releases page
                </button>
                .
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalMobile}
              onClick={() =>
                updateSettings({
                  experimentalMobile: !settings.experimentalMobile
                })
              }
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
