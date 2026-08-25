import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AppStartupSettings } from '../../../../shared/app-startup-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { getGeneralStartupSearchEntries } from './general-search'

const LOADING_STATE: AppStartupSettings = {
  supported: true,
  canModify: false,
  openAtLogin: false
}

export function GeneralStartupSettingsSection(): React.JSX.Element {
  const [startupSettings, setStartupSettings] = useState(LOADING_STATE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const searchEntry = getGeneralStartupSearchEntries()[0]

  useEffect(() => {
    let active = true
    void window.api.settings
      .getAppStartup()
      .then((settings) => {
        if (active) {
          setStartupSettings(settings)
        }
      })
      .catch(() => {
        toast.error(
          translate(
            'auto.components.settings.GeneralStartupSettingsSection.loadFailed',
            'Failed to read the launch at login setting.'
          )
        )
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const handleToggle = async (): Promise<void> => {
    if (loading || saving || !startupSettings.canModify) {
      return
    }
    setSaving(true)
    try {
      setStartupSettings(
        await window.api.settings.setAppStartup({
          openAtLogin: !startupSettings.openAtLogin
        })
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.GeneralStartupSettingsSection.updateFailed',
          'Failed to update the launch at login setting.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const label = translate(
    'auto.components.settings.GeneralStartupSettingsSection.launchAtLogin',
    'Launch Orca at login'
  )
  const installedOnly = translate(
    'auto.components.settings.GeneralStartupSettingsSection.installedOnly',
    'Available in the installed desktop app.'
  )

  return (
    <section className="space-y-4" data-testid="general-startup-settings">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.GeneralStartupSettingsSection.title', 'Startup')}
        description={translate(
          'auto.components.settings.GeneralStartupSettingsSection.description',
          'Choose whether Orca opens automatically when you sign in.'
        )}
      />
      <SearchableSetting
        title={searchEntry?.title ?? label}
        description={searchEntry?.description}
        keywords={searchEntry?.keywords}
      >
        <SettingsSwitchRow
          label={label}
          description={
            startupSettings.canModify
              ? translate(
                  'auto.components.settings.GeneralStartupSettingsSection.launchAtLoginDescription',
                  'Open Orca automatically after you sign in to this computer.'
                )
              : installedOnly
          }
          checked={startupSettings.openAtLogin}
          onChange={() => void handleToggle()}
          disabled={loading || saving || !startupSettings.canModify}
          ariaLabel={label}
        />
      </SearchableSetting>
    </section>
  )
}
