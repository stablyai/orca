import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { getHostRuntimeLabel } from '../../../../lib/provider-accounts/account-runtime-label'
import { WSL_DEFAULT_DISTRO_KEY } from '../../../provider-accounts/provider-account-visibility'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

export function renderAccountsLocationSection(
  model: AccountsPaneSectionModel,
  t: Translate = translate
): React.JSX.Element | null {
  const {
    accountRuntime,
    updateSettingsOrThrow,
    onAccountLocationChange,
    wslAvailable,
    wslCapabilitiesLoading,
    wslDistros,
    wslSupportedPlatform
  } = model
  const updateAccountLocation = async (updates: Partial<GlobalSettings>): Promise<void> => {
    try {
      // Release the chat-scoped view only after the location preference saves.
      await updateSettingsOrThrow(updates)
      onAccountLocationChange?.()
    } catch {
      toast.error(
        t(
          'auto.components.settings.AccountsPane.locationSaveFailed',
          'Account location could not be saved. Try again.'
        )
      )
    }
  }
  const accountRuntimeControls = wslSupportedPlatform ? (
    <SearchableSetting
      title={t('auto.components.settings.AccountsPane.f54b4fbd71', 'Account Location')}
      description={t(
        'auto.components.settings.AccountsPane.2cd197025c',
        'Choose whether provider accounts are inspected and added in {{value0}} or WSL.',
        { value0: getHostRuntimeLabel(t) }
      )}
      keywords={['account', 'location', 'windows', 'wsl', 'linux', 'provider', 'auth']}
    >
      <SettingsRow
        label={t('auto.components.settings.AccountsPane.46cf7e7495', 'Account location')}
        alignTop
        description={
          accountRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading
            ? t(
                'auto.components.settings.AccountsPane.0c67a2a1aa',
                'WSL is not available on this machine.'
              )
            : t(
                'auto.components.settings.AccountsPane.0b4591ff93',
                'Choose which local environment to inspect and where new managed Claude and Codex accounts are added.'
              )
        }
        control={
          <div className="flex w-44 flex-col items-stretch gap-2">
            <SettingsSegmentedControl
              ariaLabel={t('auto.components.settings.AccountsPane.46cf7e7495', 'Account location')}
              value={accountRuntime.runtime}
              onChange={(value) => void updateAccountLocation({ localAccountRuntime: value })}
              equalWidth
              options={[
                { value: 'host', label: getHostRuntimeLabel(t) },
                ...(wslSupportedPlatform
                  ? [
                      {
                        value: 'wsl',
                        label: t('auto.components.settings.AccountsPane.8619f9afa9', 'WSL'),
                        disabled: wslCapabilitiesLoading || !wslAvailable
                      } as const
                    ]
                  : [])
              ]}
            />
            {wslSupportedPlatform && accountRuntime.runtime === 'wsl' ? (
              <Select
                value={accountRuntime.wslDistro ?? WSL_DEFAULT_DISTRO_KEY}
                onValueChange={(value) =>
                  void updateAccountLocation({
                    localAccountRuntime: 'wsl',
                    localAccountWslDistro: value === WSL_DEFAULT_DISTRO_KEY ? null : value
                  })
                }
                disabled={wslCapabilitiesLoading || !wslAvailable}
              >
                <SelectTrigger size="sm" className="w-full min-w-44">
                  <SelectValue
                    placeholder={
                      wslCapabilitiesLoading
                        ? t('auto.components.settings.AccountsPane.ad47a33f72', 'Loading WSL')
                        : t('auto.components.settings.AccountsPane.2358ac71d2', 'WSL default')
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WSL_DEFAULT_DISTRO_KEY}>
                    {t('auto.components.settings.AccountsPane.2358ac71d2', 'WSL default')}
                  </SelectItem>
                  {wslDistros.map((distro) => (
                    <SelectItem key={distro} value={distro}>
                      {distro}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        }
      />
    </SearchableSetting>
  ) : null

  return (
    <div key="account-runtime" id="accounts-runtime" className="scroll-mt-6">
      <SettingsGroup>{accountRuntimeControls}</SettingsGroup>
    </div>
  )
}
