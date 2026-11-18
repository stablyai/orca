import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import { SettingsRow, SettingsSwitchRow } from '../settings/form-controls/SettingsFormControls'
import { useAppStore } from '../../store/index'
import { SettingsGroup } from '../settings/section-layout/SettingsGroup'
import { isZotzMachineModeHost, openZotzMachineModeWizard } from './zotz-machine-mode-wizard-event'
import { isZotzConductorSidebar } from '../../../../shared/zotz/zotz-sidebar-layout'

/** Settings → General entry to switch between personal and server, or re-run server setup. */
export function ZotzMachineModeSection({
  mode
}: {
  mode: GlobalSettings['zotzMachineMode']
}): React.JSX.Element | null {
  const t = useTranslate()
  const queueEnabled = useAppStore((state) => state.settings?.zotzAgentQueueEnabled !== false)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const simpleSidebar = useAppStore((state) => isZotzConductorSidebar(state.settings))
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
      <SettingsSwitchRow
        label={t('zotz.agentQueue.settingLabel', 'Agent queue by memory')}
        description={t(
          'zotz.agentQueue.settingDescription',
          'Agents start only when they fit in memory; the rest wait in line. Turning it off starts everything waiting.'
        )}
        checked={queueEnabled}
        onChange={() => void updateSettings({ zotzAgentQueueEnabled: !queueEnabled })}
      />
      <SettingsSwitchRow
        label={t('zotz.sidebar.settingLabel', 'Simple sidebar')}
        description={t(
          'zotz.sidebar.settingDescription',
          'Projects with a + button and only the conversations you started. Turn it off to see every workspace card, branch and agent.'
        )}
        checked={simpleSidebar}
        onChange={() =>
          void updateSettings({ zotzSidebarLayout: simpleSidebar ? 'orca' : 'conductor' })
        }
      />
    </SettingsGroup>
  )
}
