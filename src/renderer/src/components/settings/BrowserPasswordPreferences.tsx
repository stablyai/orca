import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSwitchRow } from './SettingsFormControls'

/** App-wide save and fill behaviour; the vault itself is per profile. */
export function BrowserPasswordPreferences({
  settings,
  updateSettings,
  canReauth
}: {
  settings: Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
  canReauth: boolean
}): React.JSX.Element {
  const offerToSave = settings.browserPasswordsOfferToSave !== false
  const fillRequiresReauth = settings.browserPasswordsFillRequiresReauth === true
  return (
    <div className="divide-y divide-border/50">
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
          'Ask for Touch ID before filling'
        )}
        description={
          canReauth
            ? translate(
                'settings.browser.passwords.fillReauthDescription',
                'For a shared computer. Showing or copying a password already asks.'
              )
            : translate(
                'settings.browser.passwords.noReauth',
                'This computer can’t confirm it’s you with Touch ID, so passwords show and fill without a check.'
              )
        }
        checked={fillRequiresReauth && canReauth}
        disabled={!canReauth}
        onChange={() => updateSettings({ browserPasswordsFillRequiresReauth: !fillRequiresReauth })}
      />
    </div>
  )
}
