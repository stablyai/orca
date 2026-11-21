import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useHostSetting } from '../settings/host-scope/use-host-setting'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AntigravityChatAuthSettingRow } from './AntigravityChatAuthSettingRow'

/** The choice the dropdown shows: an explicit one, else the sign-in in use, so an upgraded
 *  profile signed in through Orca reads "Orca's built-in sign-in", not the default's agy. */
export function antigravityGoogleSignInShown(
  saved: 'auto' | 'agy' | 'orca',
  inUse: 'agy' | 'orca'
): 'agy' | 'orca' {
  return saved === 'auto' ? inUse : saved
}

/** Whose sign-in chats on the Google account method use on this host: agy's own login (agy is
 *  installed for it), or Orca's built-in browser sign-in on Orca's server. Absent on hosts too old
 *  to honor the choice. */
export function AntigravityGoogleSignInChoice({
  owner,
  inUse,
  standalone = false
}: {
  owner: RuntimeClientTarget
  /** The sign-in new Google-account chats use now (the sign-in form shows only where they run on
   *  Orca's server), shown while the host follows its default. */
  inUse: 'agy' | 'orca'
  /** A row of its own in the Chat group, rather than one of the sign-in form's fields. */
  standalone?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const id = useId()
  const settings = useAppStore((state) => state.settings)
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const { setting, update } = useHostSetting({
    owner,
    settingKey: 'antigravityGoogleSignIn',
    localSettings: settings ?? {},
    updateLocalSettings: updateSettingsOrThrow,
    updateFailedMessage: t(
      'accounts.antigravity.googleSignInUpdateFailed',
      "Couldn't change how Antigravity signs in with Google."
    )
  })
  if (setting.state !== 'ready') {
    return null
  }
  const row = (
    <AntigravityChatAuthSettingRow
      htmlFor={id}
      label={t('accounts.antigravity.googleSignIn', 'Google account sign-in')}
    >
      <Select
        value={antigravityGoogleSignInShown(setting.value, inUse)}
        onValueChange={(value) => void update(value === 'orca' ? 'orca' : 'agy')}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value="agy"
            description={t('accounts.antigravity.googleSignInAgyOption', 'Sign in by running agy')}
          >
            {t('accounts.antigravity.googleSignInAgy', "agy's own sign-in")}
          </SelectItem>
          <SelectItem
            value="orca"
            description={t(
              'accounts.antigravity.googleSignInOrcaOption',
              'Sign in through your browser here; no agy needed'
            )}
          >
            {t('accounts.antigravity.googleSignInOrca', "Orca's built-in sign-in")}
          </SelectItem>
        </SelectContent>
      </Select>
    </AntigravityChatAuthSettingRow>
  )
  return standalone ? (
    <div data-settings-row="" className="py-3">
      {row}
    </div>
  ) : (
    row
  )
}
