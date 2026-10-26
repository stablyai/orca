import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { BrowserPasswordsStatus } from '../../../../../../shared/browser-passwords-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SettingsRow, SettingsSwitchRow } from '../../form-controls/SettingsFormControls'

// Families whose `Login Data` Orca can read; Firefox and Safari keep passwords elsewhere.
const CHROMIUM_FAMILIES = new Set(['chrome', 'chromium', 'arc', 'edge', 'comet', 'helium'])

export type BrowserPasswordImportSource = { browserFamily: string; profileDirectory: string }

export function BrowserPasswordAdvancedTab({
  settings,
  updateSettings,
  status,
  onImportCsv,
  onImportBrowser,
  onDeleteAll
}: {
  settings: Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
  status: BrowserPasswordsStatus | null
  onImportCsv: () => void
  onImportBrowser: (source: BrowserPasswordImportSource) => void
  onDeleteAll: () => void
}): React.JSX.Element {
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const detectedBrowsersHost = useAppStore((s) => s.detectedBrowsersHost)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  const offerToSave = settings.browserPasswordsOfferToSave !== false
  const fillRequiresReauth = settings.browserPasswordsFillRequiresReauth === true
  const canReauth = status?.reauthMethod === 'touch-id'
  // Only browsers on this computer: the vault never reads another machine's browser.
  const importableBrowsers =
    detectedBrowsersHost === null
      ? detectedBrowsers.filter((browser) => CHROMIUM_FAMILIES.has(browser.family))
      : []

  return (
    <div className="divide-y divide-border">
      <SettingsSwitchRow
        label={translate('settings.browser.passwords.offerToSave', 'Offer to save passwords')}
        description={translate(
          'settings.browser.passwords.offerToSaveDescription',
          'After you sign in to a site in Orca’s browser, offer to save the login.'
        )}
        checked={offerToSave}
        onChange={() => updateSettings({ browserPasswordsOfferToSave: !offerToSave })}
      />
      <SettingsSwitchRow
        label={translate(
          'settings.browser.passwords.fillReauth',
          'Use Touch ID when filling passwords'
        )}
        description={
          canReauth
            ? translate(
                'settings.browser.passwords.fillReauthDescription',
                'If you share this computer, confirm it’s you before Orca fills a saved password.'
              )
            : translate(
                'settings.browser.passwords.noReauth',
                "This computer can't confirm it's you with Touch ID, so passwords show and fill without a check."
              )
        }
        checked={fillRequiresReauth && canReauth}
        disabled={!canReauth}
        onChange={() => updateSettings({ browserPasswordsFillRequiresReauth: !fillRequiresReauth })}
      />
      <SettingsRow
        label={translate('settings.browser.passwords.importTitle', 'Import passwords')}
        description={translate(
          'settings.browser.passwords.importDescription',
          'Bring passwords from a CSV file, or from a Chromium browser on this computer.'
        )}
        control={
          <DropdownMenu onOpenChange={(open) => open && void fetchDetectedBrowsers()}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {translate('settings.browser.passwords.import', 'Import')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={onImportCsv}>
                {translate('settings.browser.passwords.importCsv', 'From a CSV file…')}
              </DropdownMenuItem>
              {importableBrowsers.length > 0 ? <DropdownMenuSeparator /> : null}
              {importableBrowsers.map((browser) => (
                <div key={browser.family}>
                  <DropdownMenuLabel>{browser.label}</DropdownMenuLabel>
                  {browser.profiles.map((profile) => (
                    <DropdownMenuItem
                      key={profile.directory}
                      onSelect={() =>
                        onImportBrowser({
                          browserFamily: browser.family,
                          profileDirectory: profile.directory
                        })
                      }
                    >
                      {profile.name}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <SettingsRow
        label={translate('settings.browser.passwords.deleteAllTitle', 'Delete all password data')}
        description={translate(
          'settings.browser.passwords.deleteAllDescription',
          'Saved passwords, notes and never-save sites for this browser profile are permanently deleted.'
        )}
        control={
          <Button type="button" variant="destructive" size="sm" onClick={onDeleteAll}>
            {translate('settings.browser.passwords.deleteAll', 'Delete data')}
          </Button>
        }
      />
    </div>
  )
}
