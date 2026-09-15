import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type NpmPackageInfoLookupSettingProps = {
  settings: Pick<GlobalSettings, 'npmPackageInfoOnlineLookupsEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NpmPackageInfoLookupSetting({
  settings,
  updateSettings
}: NpmPackageInfoLookupSettingProps): React.JSX.Element {
  const enabled = settings.npmPackageInfoOnlineLookupsEnabled ?? true
  const title = translate(
    'auto.components.settings.NpmPackageInfoLookupSetting.47381de1d4',
    'Package Metadata Lookups'
  )
  const description = translate(
    'auto.components.settings.NpmPackageInfoLookupSetting.b3496fe6cc',
    'Show live description, version, and links when hovering a dependency in package.json. Disabling this stops all network lookups, including the local npm CLI (it also queries a registry) — the installed version from node_modules keeps working.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['npm', 'package.json', 'dependency', 'hover', 'tooltip', 'registry', 'privacy']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={() => updateSettings({ npmPackageInfoOnlineLookupsEnabled: !enabled })}
      />
    </SearchableSetting>
  )
}
