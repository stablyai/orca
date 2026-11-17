import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import { SettingsRow } from '../settings/form-controls/SettingsFormControls'
import { SettingsGroup } from '../settings/section-layout/SettingsGroup'
import { isZotzMachineModeHost, openZotzMachineModeWizard } from './zotz-machine-mode-wizard-event'

/** Settings → General entry to switch between personal and server, or re-run server setup. */
export function ZotzMachineModeSection({
  mode
}: {
  mode: GlobalSettings['zotzMachineMode']
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!isZotzMachineModeHost()) {
    return null
  }
  const current =
    mode === 'server'
      ? t('zotz.machineMode.server.title', 'Remote server')
      : mode === 'personal'
        ? t('zotz.machineMode.personal.title', 'Personal')
        : t('zotz.machineMode.unset', 'Not chosen yet')
  return (
    <SettingsGroup title={t('zotz.machineMode.settingsTitle', 'This computer')}>
      <SettingsRow
        label={t('zotz.machineMode.settingsLabel', 'Machine mode: {{mode}}', { mode: current })}
        description={t(
          'zotz.machineMode.settingsDescription',
          'Switch between personal use and an always-on remote server, or run the server setup again.'
        )}
        control={
          <Button type="button" variant="outline" size="sm" onClick={openZotzMachineModeWizard}>
            {t('zotz.machineMode.change', 'Change')}
          </Button>
        }
      />
    </SettingsGroup>
  )
}
