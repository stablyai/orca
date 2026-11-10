import { useTranslate } from '@/i18n/use-translate'
import type { BrowserPasswordReauthMethod } from '../../../../../../shared/browser-passwords-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'

/** App-wide save and fill behaviour; the vault itself is per profile. */
export function BrowserPasswordPreferences({
  settings,
  updateSettings,
  reauthMethod
}: {
  settings: Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
  reauthMethod: BrowserPasswordReauthMethod | null
}): React.JSX.Element {
  const t = useTranslate()
  const offerToSave = settings.browserPasswordsOfferToSave !== false
  const fillRequiresReauth = settings.browserPasswordsFillRequiresReauth === true
  return (
    <div className="divide-y divide-border/50">
      <SettingsSwitchRow
        label={t('settings.browser.passwords.offerToSave', 'Offer to save passwords')}
        description={t(
          'settings.browser.passwords.offerToSaveDescription',
          'After you sign in to a site in Orca’s browser, offer to save the login.'
        )}
        checked={offerToSave}
        onChange={() => updateSettings({ browserPasswordsOfferToSave: !offerToSave })}
      />
      <SettingsSwitchRow
        label={t('settings.browser.passwords.fillReauth', 'Ask for Touch ID before filling')}
        description={
          reauthMethod === 'touch-id'
            ? t(
                'settings.browser.passwords.fillReauthDescription',
                'For a shared computer. Showing or copying a password already asks.'
              )
            : reauthMethod === 'touch-id-unavailable'
              ? t(
                  'settings.browser.passwords.reauthUnavailable',
                  'Touch ID can’t be used right now, so Orca won’t show, copy or fill a password that needs it.'
                )
              : t(
                  'settings.browser.passwords.noReauth',
                  'This computer can’t confirm it’s you with Touch ID, so passwords show and fill without a check.'
                )
        }
        checked={fillRequiresReauth && reauthMethod !== 'none'}
        disabled={reauthMethod !== 'touch-id'}
        onChange={() => updateSettings({ browserPasswordsFillRequiresReauth: !fillRequiresReauth })}
      />
    </div>
  )
}
