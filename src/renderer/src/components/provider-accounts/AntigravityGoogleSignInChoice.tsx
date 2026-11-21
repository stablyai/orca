import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useHostSetting } from '../settings/host-scope/use-host-setting'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AntigravityChatAuthSettingRow } from './AntigravityChatAuthSettingRow'

/** Where new Google-account chats run, by the host's answer beside the sign-in form (which shows
 *  only where Orca's server is in use): agy when it is signed in and takes them (#44613), else the
 *  server; unknown while the host hasn't answered. */
export function antigravityGoogleSignInInUse(
  state: { chatUsesAgy?: boolean } | null
): 'agy' | 'orca' | undefined {
  if (state?.chatUsesAgy === undefined) {
    return undefined
  }
  return state.chatUsesAgy ? 'agy' : 'orca'
}

/** Whose sign-in chats on the Google account method use on this host: agy's own login (agy is
 *  installed for it), or Orca's built-in browser sign-in on Orca's server. Absent on hosts too old
 *  to honor the choice. */
/** What the choice shows and whom it tells after a pick, so the host's answer is read again. */
export type AntigravityGoogleSignInState = { inUse: 'agy' | 'orca'; changed: () => void }

export function AntigravityGoogleSignInChoice({
  owner,
  inUse,
  changed,
  standalone = false
}: AntigravityGoogleSignInState & {
  owner: RuntimeClientTarget
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
        // The route in use, whatever was picked before: an explicit agy can't apply where Orca's
        // agy is switched off and agy isn't signed in.
        value={inUse}
        onValueChange={(value) => void update(value === 'orca' ? 'orca' : 'agy').then(changed)}
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
