import { useTranslate } from '@/i18n/use-translate'
import { isZotzCloudFeatureAllowed } from '../../../../shared/zotz/zotz-network-policy'
import { SettingsSwitchRow } from '../settings/form-controls/SettingsFormControls'
import { useAppStore } from '../../store/index'

export function useZotzOrcaPluginCatalogAllowed(): boolean {
  const optedIn = useAppStore((state) => state.settings?.zotzOrcaPluginCatalogEnabled === true)
  return optedIn || isZotzCloudFeatureAllowed('plugin-catalog')
}

/** Settings → Plugins opt-in for Orca's catalogs; off by default because Zotz is a fork. */
export function ZotzOrcaPluginCatalogRow(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((state) => state.settings?.zotzOrcaPluginCatalogEnabled === true)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return (
    <SettingsSwitchRow
      label={t('zotz.orcaPluginCatalog.settingLabel', "Download Orca's plugin catalog")}
      description={t(
        'zotz.orcaPluginCatalog.settingDescription',
        'Shows the official and community plugins from Orca and checks their safety list. Off by default because Zotz is a fork; your own plugin sources work either way.'
      )}
      checked={enabled}
      onChange={() => void updateSettings({ zotzOrcaPluginCatalogEnabled: !enabled })}
    />
  )
}
